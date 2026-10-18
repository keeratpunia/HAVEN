import { Platform } from 'react-native';
import {
  IDEMPOTENCY_HEADER,
  type ChargeDTO,
  type CreateVisitBody,
  type HostedVisitBucket,
  type MeUserDTO,
  type NotificationDTO,
  type Paged,
  type QuotaDTO,
  type VisitDetailDTO,
  type VisitDTO,
  type VisitPreview,
} from '@haven/shared';
import { readRefreshToken, usesBodyRefreshToken, writeRefreshToken } from '../lib/token-store.js';

/**
 * The app's API client (guest web and resident app). The app NEVER touches the
 * database — every call here is a `fetch` to the Fastify API (CLAUDE.md §3.1). The
 * access token lives in memory only (module state, SDD §9.5). The refresh token is the
 * httpOnly `haven_rt` cookie on the web (`credentials: 'include'`) and lives in
 * expo-secure-store on Android, where requests carry `X-Client: native` so the API
 * returns it in the body (SDD §9.5).
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080';
const NATIVE = Platform.OS !== 'web';

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
  /** SDD §9.12: ★ actions carry one key per user action, reused on retries. */
  idempotencyKey?: string;
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
  if (options.idempotencyKey) headers[IDEMPOTENCY_HEADER] = options.idempotencyKey;
  if (NATIVE) headers['X-Client'] = 'native';

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
    const stored = usesBodyRefreshToken ? await readRefreshToken() : null;
    if (usesBodyRefreshToken && !stored) return false;
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(NATIVE ? { 'X-Client': 'native' } : {}),
      },
      body: JSON.stringify(stored ? { refreshToken: stored } : {}),
    });
    if (!res.ok) {
      if (usesBodyRefreshToken) await writeRefreshToken(null);
      return false;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken?: string };
    setAccessToken(data.accessToken);
    if (usesBodyRefreshToken && data.refreshToken) await writeRefreshToken(data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/** After any sign-in: keep the session (memory access token; native refresh token). */
export async function acceptSession(result: {
  accessToken: string;
  refreshToken?: string;
}): Promise<void> {
  setAccessToken(result.accessToken);
  if (usesBodyRefreshToken && result.refreshToken) await writeRefreshToken(result.refreshToken);
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

/** R-02: a signed-in resident verifies their phone (SDD F7 step 3, purpose phone_verify). */
export function verifyResidentPhone(phone: string, code: string) {
  return request<{ phoneVerified: true }>('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone, code, purpose: 'phone_verify' },
  });
}

/** Dev-only resident/staff sign-in bypass (docs/DECISIONS.md DEC-011) — only reachable
 * when the API registered the route (DEV_LOGIN_ENABLED=true, NODE_ENV=development). */
export function devLogin(email: string) {
  return request<{
    accessToken: string;
    expiresAt: string;
    refreshToken?: string;
    principal: { type: 'user'; id: string; roles: { h: string; r: string }[] };
  }>('/v1/auth/dev-login', { method: 'POST', auth: false, body: { email } });
}

export async function logout() {
  try {
    await request<void>('/v1/auth/logout', { method: 'POST' });
  } finally {
    setAccessToken(null);
    await writeRefreshToken(null);
  }
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

export type MeUser = MeUserDTO;

export function getMe() {
  return request<MeVisitor | MeUser>('/v1/me');
}

export function patchMe(patch: {
  fullName?: string;
  gender?: 'male' | 'female' | 'undisclosed';
  isAdultConfirmed?: true;
}) {
  return request<void>('/v1/me', { method: 'PATCH', body: patch });
}

/** SDD §9.4, G-05 — the guest's live profile selfie. */
export function uploadProfilePhoto(photo: Blob) {
  const formData = new FormData();
  formData.append('photo', photo, 'photo.jpg');
  return request<{ photoId: string }>('/v1/me/profile-photo', { method: 'POST', formData });
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

/** FR-26 — guest cancels their own pending walk-in request (SDD §12.4). */
export function cancelMyVisit(id: string) {
  return request<VisitDto>(`/v1/me/visits/${id}/cancel`, { method: 'POST' });
}

// ---- Resident: onboarding, host visit actions, notifications (SDD §12.4-§12.6) ----

export function googleSignIn(idToken: string) {
  return request<{
    accessToken: string;
    expiresAt: string;
    refreshToken?: string;
    principal: { type: 'user'; id: string; residentStatus: string | null };
  }>('/v1/auth/google', { method: 'POST', auth: false, body: { idToken } });
}

export function saveResidentDraft(body: { hostelId: string; room: string }) {
  return request<{ ok: true }>('/v1/residents/me', { method: 'POST', body });
}

export function uploadResidentDocument(kind: 'id_card' | 'selfie', photo: Blob) {
  const formData = new FormData();
  // `kind` must precede the file: the server reads fields sent before the file part.
  formData.append('kind', kind);
  formData.append('photo', photo, `${kind}.jpg`);
  return request<{ photoId: string }>('/v1/residents/me/documents', { method: 'POST', formData });
}

export function submitResident() {
  return request<void>('/v1/residents/me/submit', { method: 'POST' });
}

export function previewVisit(body: CreateVisitBody) {
  return request<VisitPreview>('/v1/visits/preview', { method: 'POST', body });
}

export function createVisit(body: CreateVisitBody) {
  return request<{ visit: VisitDTO; inviteUrl?: string }>('/v1/visits', { method: 'POST', body });
}

export function getHostedVisits(
  params: { bucket?: HostedVisitBucket; cursor?: string | null; limit?: number } = {},
) {
  const q = new URLSearchParams();
  if (params.bucket) q.set('bucket', params.bucket);
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return request<Paged<VisitDTO>>(`/v1/me/hosted-visits${qs ? `?${qs}` : ''}`);
}

export function getHostedVisit(id: string) {
  return request<VisitDetailDTO>(`/v1/visits/${id}`);
}

export function editVisitWindow(id: string, body: { windowStart?: string; windowEnd?: string }) {
  return request<VisitDTO>(`/v1/visits/${id}`, { method: 'PATCH', body });
}

export function cancelHostedVisit(id: string, reason?: string) {
  return request<VisitDTO>(`/v1/visits/${id}/cancel`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export function newInviteLink(id: string) {
  return request<{ inviteUrl: string }>(`/v1/visits/${id}/invite-link`, { method: 'POST' });
}

/** ★ actions (SDD §12.6) — the caller passes one key per user action (SDD §9.12). */
export function approveVisit(id: string, key: string, windowEnd?: string) {
  return request<VisitDTO>(`/v1/visits/${id}/approve`, {
    method: 'POST',
    body: windowEnd ? { windowEnd } : {},
    idempotencyKey: key,
  });
}

export function rejectVisit(id: string, key: string, reason?: string) {
  return request<VisitDTO>(`/v1/visits/${id}/reject`, {
    method: 'POST',
    body: reason ? { reason } : {},
    idempotencyKey: key,
  });
}

export function confirmArrival(id: string, key: string) {
  return request<VisitDTO>(`/v1/visits/${id}/confirm-arrival`, {
    method: 'POST',
    idempotencyKey: key,
  });
}

export function disputeArrival(id: string, key: string, note?: string) {
  return request<VisitDTO>(`/v1/visits/${id}/dispute`, {
    method: 'POST',
    body: note ? { note } : {},
    idempotencyKey: key,
  });
}

export function markGuestLeft(id: string, key: string) {
  return request<VisitDTO>(`/v1/visits/${id}/mark-left`, { method: 'POST', idempotencyKey: key });
}

export function getQuota(month?: string) {
  return request<QuotaDTO>(`/v1/me/quota${month ? `?month=${month}` : ''}`);
}

export function getCharges(cursor?: string | null) {
  return request<Paged<ChargeDTO>>(
    `/v1/me/charges${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
}

export function registerPushToken(expoToken: string, platform: 'android' | 'ios' | 'web') {
  return request<void>('/v1/me/push-tokens', { method: 'POST', body: { expoToken, platform } });
}

export function getNotifications(cursor?: string | null) {
  return request<Paged<NotificationDTO>>(
    `/v1/me/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
}

export function markNotificationOpened(id: string) {
  return request<void>(`/v1/notifications/${id}/opened`, { method: 'POST' });
}

/** R-12: host-assisted entry and exit at the gate (SDD F4, §12.8 ★). */
export function hostAssistedEntry(
  sessionId: string,
  nonce: string,
  key: string,
  body: {
    guest: { name: string; gender: 'female' | 'male' | 'undisclosed'; phone?: string | null };
    type: 'day' | 'quick_drop';
    durationMinutes: number;
    photoId: string;
  },
) {
  return request<{ visit: VisitDto }>(`/v1/scan-sessions/${sessionId}/host-assisted-entry`, {
    method: 'POST',
    body,
    headers: { 'X-Scan-Nonce': nonce },
    idempotencyKey: key,
  });
}

export function hostAssistedExit(sessionId: string, nonce: string, key: string, visitId: string) {
  return request<{ visit: VisitDto }>(`/v1/scan-sessions/${sessionId}/host-assisted-exit`, {
    method: 'POST',
    body: { visitId },
    headers: { 'X-Scan-Nonce': nonce },
    idempotencyKey: key,
  });
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
