/**
 * Guest web API client. The web app NEVER touches the database — every call here is a
 * `fetch` to the Fastify API (CLAUDE.md §3.1: "Clients never touch the database
 * directly"). The access token lives in memory only (module state, SDD §9.5); the
 * refresh token is an httpOnly cookie the browser manages automatically
 * (`credentials: 'include'`) — this module never reads or stores it.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  auth?: boolean;
  /** Set internally to prevent infinite refresh loops. */
  _retried?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  // Fastify's JSON body parser rejects an empty body when Content-Type is set to
  // application/json (FST_ERR_CTP_EMPTY_JSON_BODY) — only declare it when there's
  // actually a body to parse.
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401 && !options._retried && options.auth !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return request<T>(path, { ...options, _retried: true });
    }
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const json = (await res.json().catch(() => null)) as
    T | { error: { code: string; message: string; details?: unknown } } | null;

  if (!res.ok) {
    const errBody = json as { error?: { code: string; message: string; details?: unknown } } | null;
    throw new ApiError(
      errBody?.error?.code ?? 'INTERNAL',
      res.status,
      errBody?.error?.message ?? 'Something went wrong.',
      errBody?.error?.details,
    );
  }

  return json as T;
}

// Refresh tokens rotate on use (single-use), so two requests that 401 at the same
// moment (e.g. a screen's own data fetch racing the AuthProvider's `GET /me` on a
// full page reload) must not each call this independently — the second would present
// an already-rotated, now-dead cookie and fail. Share one in-flight attempt instead.
let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

// ---- Auth ----

export function requestOtp(phone: string, purpose: 'guest_login' | 'phone_verify') {
  return request<{ resendAfterS: number }>('/v1/auth/otp/request', {
    method: 'POST',
    auth: false,
    body: { phone, purpose },
  });
}

export interface VerifyOtpResult {
  accessToken: string;
  expiresAt: string;
  principal: { type: 'visitor'; id: string; profileComplete: boolean };
}

export function verifyOtp(phone: string, code: string, purpose: 'guest_login' | 'phone_verify') {
  return request<VerifyOtpResult>('/v1/auth/otp/verify', {
    method: 'POST',
    auth: false,
    body: { phone, code, purpose },
  });
}

export function logout() {
  return request<void>('/v1/auth/logout', { method: 'POST' });
}

// ---- Profile ----

export interface MeVisitor {
  type: 'visitor';
  id: string;
  fullName: string;
  phone: string | null;
  gender: 'male' | 'female' | 'undisclosed';
  isAdultConfirmed: boolean;
}

export function getMe() {
  return request<MeVisitor>('/v1/me');
}

export function patchMe(patch: {
  fullName?: string;
  gender?: 'male' | 'female' | 'undisclosed';
  isAdultConfirmed?: true;
}) {
  return request<void>('/v1/me', { method: 'PATCH', body: patch });
}

// ---- Invites ----

export interface InviteLanding {
  hostFirstName: string;
  hostelName: string;
  type: string;
  windowStart: string;
  windowEnd: string;
  invitedPhoneMasked: string | null;
  status: string;
  claimed: boolean;
}

export function getInvite(token: string) {
  return request<InviteLanding>(`/v1/invites/${encodeURIComponent(token)}`, { auth: false });
}

export function claimInvite(token: string) {
  return request<{ visitId: string }>(`/v1/invites/${encodeURIComponent(token)}/claim`, {
    method: 'POST',
  });
}

// ---- Visits ----

export interface VisitDto {
  id: string;
  code: string;
  status: string;
  type: string;
  zone: string;
  windowStart: string;
  windowEnd: string;
  closeReason: string | null;
  firstEntryAt: string | null;
  lastExitAt: string | null;
  locationUnverified: boolean;
  hostFirstName?: string;
  hostelName?: string;
}

export function getVisit(id: string) {
  return request<VisitDto>(`/v1/visits/${id}`);
}

export function getMyVisits() {
  return request<VisitDto[]>('/v1/me/visits');
}

export interface GateLocation {
  lat: number;
  lng: number;
  accuracyM?: number;
}

export function checkIn(visitId: string, location: GateLocation) {
  return request<VisitDto>(`/v1/visits/${visitId}/check-in`, { method: 'POST', body: location });
}

export function checkOut(visitId: string, location: GateLocation) {
  return request<VisitDto>(`/v1/visits/${visitId}/check-out`, { method: 'POST', body: location });
}

export function getHostels() {
  return request<{ id: string; code: string; name: string }[]>('/v1/hostels', { auth: false });
}

export function searchRooms(hostelId: string, number: string) {
  return request<{ userId: string; fullName: string }[]>(
    `/v1/rooms/search?hostelId=${encodeURIComponent(hostelId)}&number=${encodeURIComponent(number)}`,
  );
}

export function createWalkIn(params: {
  hostUserId: string;
  type: 'day' | 'quick_drop';
  guestGender: 'male' | 'female' | 'undisclosed' | null;
  durationMinutes: number;
}) {
  return request<VisitDto>('/v1/visits/walk-in', { method: 'POST', body: params });
}
