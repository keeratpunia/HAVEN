import { z } from 'zod';

/**
 * Notification contracts (SDD §12.4 push-token/notification endpoints, §15.1 push
 * payload) plus the single source of truth for "which screen does tapping this open"
 * (SDD §13.7: "Push tap behaviour: opens the exact screen (R-08 for walk-ins, R-09 for
 * arrivals, W-05 for disputes)"). The API stamps `screen` into each push payload and
 * the app routes on it, so both sides share this table rather than each guessing.
 */

export const PushTokenBodySchema = z.object({
  expoToken: z.string().min(1).max(200),
  platform: z.enum(['android', 'ios', 'web']),
});

export const NotificationsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** Every kind in SDD §15.2 (plus §7.1's guest-page-only N-WALKIN-REJECTED). */
export type NotificationKind =
  | 'N-WALKIN'
  | 'N-WALKIN-EXPIRED'
  | 'N-WALKIN-REJECTED'
  | 'N-CONFIRM-LOCATION'
  | 'N-ARRIVED'
  | 'N-LEFT'
  | 'N-OVERSTAY-HOST'
  | 'N-OVERSTAY-GUEST'
  | 'N-OVERSTAY-WARDEN'
  | 'N-NIGHT-SWEEP'
  | 'N-NIGHT-SWEEP-HOST'
  | 'N-DISPUTE'
  | 'N-OVERNIGHT-REQ'
  | 'N-OVERNIGHT-DECIDED'
  | 'N-RES-SUBMITTED'
  | 'N-RES-DECIDED'
  | 'N-GATE-OFFLINE'
  | 'N-CHARGE'
  | 'N-HOST-SUSPENDED'
  // FR-60 daily digest: not in SDD §15.2; added with the team's approval (DEC-016).
  | 'N-DIGEST';

/** SDD §15.1 Android channels. */
export type AndroidChannelId = 'approvals' | 'alerts' | 'updates';

export const ANDROID_CHANNELS: {
  id: AndroidChannelId;
  name: string;
  importance: 'high' | 'default';
}[] = [
  { id: 'approvals', name: 'Guest requests', importance: 'high' },
  { id: 'alerts', name: 'Alerts', importance: 'high' },
  { id: 'updates', name: 'Guest updates', importance: 'default' },
];

export function channelForKind(kind: string): AndroidChannelId {
  switch (kind) {
    case 'N-WALKIN':
    case 'N-CONFIRM-LOCATION':
    case 'N-OVERNIGHT-REQ':
    case 'N-RES-SUBMITTED':
      return 'approvals';
    case 'N-DISPUTE':
    case 'N-OVERSTAY-HOST':
    case 'N-OVERSTAY-WARDEN':
    case 'N-NIGHT-SWEEP':
    case 'N-NIGHT-SWEEP-HOST':
    case 'N-GATE-OFFLINE':
    case 'N-DIGEST':
      return 'alerts';
    default:
      return 'updates';
  }
}

/** App routes a notification can open (resident app routes under `(resident)`). */
export const RESIDENT_SCREENS = {
  home: '/home',
  guests: '/guests',
  charges: '/charges',
  account: '/account',
  notifications: '/notifications',
  walkIn: (visitId: string) => `/walk-in/${visitId}`,
  arrival: (visitId: string) => `/arrival/${visitId}`,
  visit: (visitId: string) => `/visit/${visitId}`,
} as const;

/** Warden screens (W-01/W-04/W-05) — the warden app is a later milestone; the routes
 * are fixed now so payloads produced today stay valid when it ships. */
export const WARDEN_SCREENS = {
  dashboard: '/warden',
  approvals: '/warden/approvals',
  visit: (visitId: string) => `/warden/visits/${visitId}`,
} as const;

/**
 * Default screen for a notification kind when the producer didn't stamp a more
 * specific one (SQL jobs insert rows directly). N-CONFIRM-LOCATION is the one kind
 * whose screen depends on context — R-08 for a walk-in, R-09 for a pre-invite
 * check-in — so its producers always stamp `screen` explicitly.
 */
export function defaultScreenForKind(kind: string, visitId: string | null): string {
  switch (kind) {
    case 'N-WALKIN':
      return visitId ? RESIDENT_SCREENS.walkIn(visitId) : RESIDENT_SCREENS.home;
    case 'N-CONFIRM-LOCATION':
    case 'N-ARRIVED':
      return visitId ? RESIDENT_SCREENS.arrival(visitId) : RESIDENT_SCREENS.home;
    case 'N-WALKIN-EXPIRED':
    case 'N-LEFT':
    case 'N-OVERSTAY-HOST':
    case 'N-NIGHT-SWEEP-HOST':
    case 'N-OVERNIGHT-DECIDED':
      return visitId ? RESIDENT_SCREENS.visit(visitId) : RESIDENT_SCREENS.guests;
    case 'N-CHARGE':
      return RESIDENT_SCREENS.charges;
    case 'N-RES-DECIDED':
    case 'N-HOST-SUSPENDED':
      return RESIDENT_SCREENS.home;
    case 'N-DISPUTE':
    case 'N-OVERSTAY-WARDEN':
      return visitId ? WARDEN_SCREENS.visit(visitId) : WARDEN_SCREENS.dashboard;
    case 'N-OVERNIGHT-REQ':
    case 'N-RES-SUBMITTED':
      return WARDEN_SCREENS.approvals;
    case 'N-NIGHT-SWEEP':
      return '/warden/inside';
    case 'N-GATE-OFFLINE':
      return '/warden/gates';
    case 'N-DIGEST':
      return '/warden/reports';
    default:
      return visitId ? RESIDENT_SCREENS.visit(visitId) : RESIDENT_SCREENS.home;
  }
}

/** SDD §15.1: "Push data payload is always { kind, notificationId, visitId?, screen }". */
export interface PushData {
  kind: string;
  notificationId: string;
  visitId?: string;
  screen: string;
}

export function isPushData(value: unknown): value is PushData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === 'string' &&
    typeof v.notificationId === 'string' &&
    typeof v.screen === 'string' &&
    (v.visitId === undefined || typeof v.visitId === 'string')
  );
}

/**
 * The only screens a tapped payload may navigate to: a known static route, or a known
 * visit route with a UUID. Anything else (a malformed or hostile payload) falls back to
 * home rather than being handed to the router verbatim.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SAFE_SCREEN_PATTERNS = [
  /^\/(home|guests|charges|account|notifications|invite|overnight|assist)$/,
  new RegExp(`^/(walk-in|arrival|visit)/${UUID}$`, 'i'),
  /^\/warden(\/approvals)?$/,
  new RegExp(`^/warden/visits/${UUID}$`, 'i'),
];

export function safeScreen(screen: string | undefined | null): string {
  if (screen && SAFE_SCREEN_PATTERNS.some((p) => p.test(screen))) return screen;
  return RESIDENT_SCREENS.home;
}

/** One row of `GET /me/notifications` (in-app list). */
export interface NotificationDTO {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  visitId: string | null;
  screen: string;
  createdAt: string;
  openedAt: string | null;
}
