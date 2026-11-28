import { z } from 'zod';
import type { RuleCode, Zone } from '../rules/index.js';

/**
 * Host-side visit contracts (SDD §12.3 shared objects, §12.6 Visits (host)). Every
 * request schema here is the one the API validates against and the app type-checks
 * against — "If an endpoint isn't in this section, it doesn't exist" (SDD §12).
 */

export const PhoneE164Schema = z
  .string()
  .regex(/^\+91[6-9][0-9]{9}$/, 'Enter a valid Indian mobile number.');
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const GuestSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: PhoneE164Schema,
  gender: z.enum(['female', 'male', 'undisclosed']).optional(),
});

/** SDD §12.6 "Create body" — invite (FR-10) or overnight/guest-room request (FR-14). */
export const CreateVisitBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('invite'),
    guest: GuestSchema,
    type: z.enum(['quick_drop', 'day']),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('overnight'),
    // SDD §12.6: "Gender is required for overnight (BR-07)".
    guest: GuestSchema.extend({ gender: z.enum(['female', 'male', 'undisclosed']) }),
    type: z.enum(['overnight_room', 'guest_room']),
    arrivalDate: LocalDateSchema,
    departureDate: LocalDateSchema,
  }),
]);
export type CreateVisitBody = z.infer<typeof CreateVisitBodySchema>;

export interface QuotaMonth {
  month: string;
  used: number;
  after: number;
}

/** `POST /visits/preview` response — no write (SDD §12.6, F6 step 2). */
export interface VisitPreview {
  decision: 'allow' | 'allow_flagged' | 'deny';
  codes: RuleCode[];
  zone: Zone | null;
  nights: number;
  chargeInr: number;
  quota: QuotaMonth[];
}

export const ApproveBodySchema = z.object({ windowEnd: z.string().datetime().optional() });
export const RejectBodySchema = z.object({ reason: z.string().trim().max(300).optional() });
export const CancelBodySchema = z.object({ reason: z.string().trim().max(300).optional() });
export const PatchVisitBodySchema = z
  .object({
    windowStart: z.string().datetime().optional(),
    windowEnd: z.string().datetime().optional(),
  })
  .refine((b) => b.windowStart !== undefined || b.windowEnd !== undefined, {
    message: 'Change the start or end time.',
  });

export const HOSTED_VISIT_BUCKETS = ['upcoming', 'inside', 'history'] as const;
export type HostedVisitBucket = (typeof HOSTED_VISIT_BUCKETS)[number];
export const HostedVisitsQuerySchema = z.object({
  bucket: z.enum(HOSTED_VISIT_BUCKETS).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** SDD §12.1 pagination envelope. */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PhotoDTO {
  url: string;
  expiresAt: string;
}

export type VisitStatus =
  | 'pending_host'
  | 'pending_warden'
  | 'approved'
  | 'inside'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/**
 * Every action the API may list in `allowedActions` for a host. SDD §12.3: "The app
 * MUST use allowedActions to show or hide buttons instead of re-deriving permissions."
 */
export type VisitAction =
  | 'approve'
  | 'reject'
  | 'confirm_arrival'
  | 'mark_left'
  | 'cancel'
  | 'edit'
  | 'share_invite'
  // Warden (W-05), computed only for warden callers:
  | 'force_checkout'
  | 'resolve_dispute'
  | 'ban';

/** SDD §12.3 `VisitDTO`. */
export interface VisitDTO {
  id: string;
  code: string;
  hostel: { id: string; code: string; name: string };
  host: { id: string; displayName: string; room: string };
  guest: {
    id: string | null;
    name: string;
    gender: 'female' | 'male' | 'undisclosed' | null;
    phoneMasked: string | null;
    profilePhoto: PhotoDTO | null;
  };
  type: 'quick_drop' | 'day' | 'overnight_room' | 'guest_room';
  status: VisitStatus;
  origin: 'invite' | 'walk_in' | 'host_assisted' | 'overnight_request';
  zone: Zone;
  windowStart: string;
  windowEnd: string;
  nights: number;
  flags: {
    overstay: boolean;
    disputed: boolean;
    locationUnverified: boolean;
    exitLocationUnverified: boolean;
  };
  firstEntryAt: string | null;
  lastExitAt: string | null;
  latestPhoto: PhotoDTO | null;
  charge: { amountInr: number; status: string } | null;
  allowedActions: VisitAction[];
  /** Host-view extras the R-08/R-09 cards need beyond §12.3's list. */
  hostConfirmedAt: string | null;
  /** True while a guest's location-unverified check-in is waiting on the host (SDD F3). */
  awaitingHostConfirmation: boolean;
}

export type VisitEventKind =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'entry'
  | 'exit'
  | 'entry_denied'
  | 'host_confirmed'
  | 'disputed'
  | 'dispute_resolved'
  | 'overstay'
  | 'closed';

/** One row of the R-10/W-05 timeline (newest at bottom, SDD §14 layout rules). */
export interface VisitEventDTO {
  kind: VisitEventKind;
  at: string;
  locationVerified?: boolean;
  distanceM?: number | null;
  photo?: PhotoDTO | null;
  reason?: string | null;
}

export interface VisitDetailDTO extends VisitDTO {
  events: VisitEventDTO[];
}
