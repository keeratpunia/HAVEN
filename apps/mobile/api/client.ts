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
  /** Raw form-data body (photo uploads) — sent as-is, no JSON Content-Type. */
  formData?: FormData;
  auth?: boolean;
  headers?: Record<string, string>;
  /** Set internally to prevent infinite refresh loops. */
  _retried?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  // Fastify's JSON body parser rejects an empty body when Content-Type is set to
  // application/json (FST_ERR_CTP_EMPTY_JSON_BODY) — only declare it when there's
  // actually a JSON body to parse (never for FormData — the browser sets its own
  // multipart Content-Type with the boundary).
  if (options.body !== undefined && !options.formData) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    body:
      options.formData ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
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

export function getHostels() {
  return request<{ id: string; code: string; name: string }[]>('/v1/hostels', { auth: false });
}

export function searchRooms(hostelId: string, number: string) {
  return request<{ userId: string; fullName: string }[]>(
    `/v1/rooms/search?hostelId=${encodeURIComponent(hostelId)}&number=${encodeURIComponent(number)}`,
  );
}

// ---- Gate / scan sessions (SDD §9.3, §12.8) ----
// Replaces the guest-web milestone's temporary /v1/visits/:id/check-in,
// /v1/visits/:id/check-out and /v1/visits/walk-in endpoints — see docs/DECISIONS.md
// DEC-010. Every call after creation sends `X-Scan-Nonce` (SDD §9.3 "Binding").

export interface ScanLocation {
  lat: number;
  lng: number;
  accuracy: number;
  fixAgeMs: number;
  mocked?: boolean;
}

export interface ScanSessionResult {
  scanSessionId: string;
  gpsOk: boolean;
  gpsFailure: string | null;
  distanceM: number | null;
  hostel: { id: string; name: string };
  gate: { id: string; name: string };
  expiresAt: string;
}

export function createScanSession(params: {
  token: string;
  clientNonce: string;
  location: ScanLocation | null;
}) {
  return request<ScanSessionResult>('/v1/scan-sessions', {
    method: 'POST',
    auth: false,
    body: params,
  });
}

export function retryScanSessionLocation(sessionId: string, location: ScanLocation | null) {
  return request<ScanSessionResult>(`/v1/scan-sessions/${sessionId}/location`, {
    method: 'POST',
    auth: false,
    body: { location },
  });
}

export interface ScanSessionActions {
  gpsOk: boolean;
  actions: ('check_in' | 'check_out' | 'request_entry')[];
  visits: VisitDto[];
}

export function getScanSession(sessionId: string, nonce: string) {
  return request<ScanSessionActions>(`/v1/scan-sessions/${sessionId}`, {
    headers: { 'X-Scan-Nonce': nonce },
  });
}

export function uploadScanSessionPhoto(sessionId: string, nonce: string, photo: Blob) {
  const formData = new FormData();
  formData.append('photo', photo, 'photo.jpg');
  return request<{ photoId: string }>(`/v1/scan-sessions/${sessionId}/photo`, {
    method: 'POST',
    formData,
    headers: { 'X-Scan-Nonce': nonce },
  });
}

export function scanSessionCheckIn(
  sessionId: string,
  nonce: string,
  params: { visitId: string; photoId: string },
) {
  return request<{ visit: VisitDto; result: 'inside' | 'awaiting_host_confirmation' }>(
    `/v1/scan-sessions/${sessionId}/check-in`,
    { method: 'POST', body: params, headers: { 'X-Scan-Nonce': nonce } },
  );
}

export function scanSessionCheckOut(
  sessionId: string,
  nonce: string,
  params: { visitId: string; photoId: string },
) {
  return request<{ visit: VisitDto }>(`/v1/scan-sessions/${sessionId}/check-out`, {
    method: 'POST',
    body: params,
    headers: { 'X-Scan-Nonce': nonce },
  });
}

export function scanSessionWalkIn(
  sessionId: string,
  nonce: string,
  params: { hostId: string; type: 'day' | 'quick_drop'; durationMinutes: number; photoId: string },
) {
  return request<{ visit: VisitDto }>(`/v1/scan-sessions/${sessionId}/walk-in`, {
    method: 'POST',
    body: params,
    headers: { 'X-Scan-Nonce': nonce },
  });
}

// ---- Gate devices (SDD F8, §12.8/§12.9) ----

export interface PairDeviceResult {
  deviceToken: string;
  gate: { code: string; name: string };
  hostelName: string;
  secret: string;
  secretVersion: number;
  serverTime: string;
}

export function pairGateDevice(code: string, label?: string) {
  return request<PairDeviceResult>('/v1/gate-devices/pair', {
    method: 'POST',
    auth: false,
    body: { code, label },
  });
}

export interface HeartbeatResult {
  serverTime: string;
  secretVersion: number;
  secret?: string;
  revoked: boolean;
}

export function gateDeviceHeartbeat(deviceToken: string, clientTime: string) {
  return request<HeartbeatResult>('/v1/gate-devices/heartbeat', {
    method: 'POST',
    auth: false,
    headers: { Authorization: `Device ${deviceToken}` },
    body: { clientTime },
  });
}
