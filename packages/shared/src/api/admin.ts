import { z } from 'zod';
import { RulesConfigSchema } from '../rules/config.js';
import type { PhotoDTO, VisitDTO, VisitEventDTO } from './visits.js';

/** Warden and office contracts (SDD §12.9, `/v1/admin`, header `X-Hostel-Id`). */

export const HOSTEL_HEADER = 'X-Hostel-Id';

const Reason = z.string().trim().min(1, 'A reason is required.').max(300);
const Uuid = z.string().uuid();

export interface DashboardDTO {
  counts: {
    inside: number;
    expectedToday: number;
    overstaying: number;
    disputed: number;
    pendingApprovals: number;
    pendingResidents: number;
  };
  gates: {
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: string | null;
    configured: boolean;
  }[];
  /** W-01 "latest 10 events". */
  latestEvents: {
    visitId: string;
    visitCode: string;
    guestName: string;
    kind: 'entry' | 'exit' | 'entry_denied';
    at: string;
    locationVerified: boolean;
  }[];
}

export const AdminVisitsQuerySchema = z.object({
  status: z
    .enum([
      'pending_host',
      'pending_warden',
      'approved',
      'inside',
      'completed',
      'rejected',
      'expired',
      'cancelled',
    ])
    .optional(),
  type: z.enum(['quick_drop', 'day', 'overnight_room', 'guest_room']).optional(),
  flag: z
    .enum([
      'overstay',
      'disputed',
      'location_unverified',
      'exit_location_unverified',
      'host_marked_left',
    ])
    .optional(),
  q: z.string().trim().max(80).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  expectedToday: z.enum(['true']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** The warden's view of a visit: the full phone (SDD §3.3 "See guest phone": Hostel). */
export type AdminVisitDTO = VisitDTO & {
  guestPhone: string | null;
  closeReason: string | null;
  disputeResolvedAt: string | null;
};

export interface AdminVisitNotificationDTO {
  kind: string;
  channel: 'push' | 'sms' | 'in_app';
  status: string;
  recipientType: 'user' | 'visitor' | 'phone';
  createdAt: string;
  sentAt: string | null;
  openedAt: string | null;
}

export interface AdminVisitDetailDTO extends AdminVisitDTO {
  events: VisitEventDTO[];
  notifications: AdminVisitNotificationDTO[];
}

export const ForceCheckoutBodySchema = z.object({ reason: Reason });
export const ResolveDisputeBodySchema = z.object({ note: z.string().trim().max(300).optional() });

export interface EmergencyRowDTO {
  visitId: string;
  guestName: string;
  hostName: string;
  room: string;
  zone: string;
  since: string;
  type: string;
}

export interface ApprovalDTO {
  visit: AdminVisitDTO;
  arrivalDate: string;
  departureDate: string;
  chargeInr: number;
  quota: { month: string; used: number; limit: number }[];
  hostHistory: { overnightStays: number; visits: number; disputes: number };
}

export const AdminResidentsQuerySchema = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'suspended', 'left']).optional(),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface AdminResidentDTO {
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  room: string;
  status: 'pending' | 'verified' | 'rejected' | 'suspended' | 'left';
  submittedAt: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  hostingSuspendedUntil: string | null;
  /** Only while a decision is pending (FR-05); the ID card is deleted on decision. */
  idCardPhoto: PhotoDTO | null;
  selfie: PhotoDTO | null;
  /** F7 step 6 / E-20: other verified residents already in that room. */
  roommates: { userId: string; fullName: string }[];
}

export const RejectResidentBodySchema = z.object({ reason: Reason });
export const SuspendResidentBodySchema = z.object({
  until: z.string().datetime().optional(),
  reason: Reason,
});

export const CreateBanBodySchema = z.object({
  visitorId: Uuid,
  allHostels: z.boolean(),
  endsAt: z.string().datetime().optional(),
  reason: Reason,
});
export const LiftBanBodySchema = z.object({ reason: Reason });

export interface BanDTO {
  id: string;
  visitorId: string;
  guestName: string;
  allHostels: boolean;
  reason: string;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  liftedAt: string | null;
}

export const PublishRulesBodySchema = z.object({ config: RulesConfigSchema });
export interface RulesDTO {
  version: number;
  config: z.infer<typeof RulesConfigSchema>;
  createdAt: string | null;
}

export const GateLocationBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(10).max(300),
  maxAccuracyM: z.number().int().min(10).max(200),
});

export interface GateDTO {
  id: string;
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
  radiusM: number;
  maxAccuracyM: number;
  configured: boolean;
  locationSetAt: string | null;
  devices: {
    id: string;
    label: string;
    online: boolean;
    lastSeenAt: string | null;
    pairedAt: string;
  }[];
}

export const StaffInviteBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['office', 'warden']),
});

export interface StaffDTO {
  members: {
    userId: string;
    fullName: string;
    email: string;
    role: 'warden' | 'office';
    grantedAt: string;
    active: boolean;
  }[];
  invites: {
    id: string;
    email: string;
    role: 'warden' | 'office';
    expiresAt: string;
    acceptedAt: string | null;
  }[];
}

export const CreateHostelBodySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{2,12}$/, 'Use capital letters, digits and "-".'),
  name: z.string().trim().min(2).max(80),
  genderServed: z.enum(['female', 'male']),
});

export const AdminChargesQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'paid', 'waived']).optional(),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const CreateFineBodySchema = z.object({
  residentId: Uuid,
  amountInr: z.number().int(),
  description: z.string().trim().min(2).max(200),
  visitId: Uuid.optional(),
});
export const MarkPaidBodySchema = z.object({ receiptNo: z.string().trim().min(1).max(40) });
export const WaiveBodySchema = z.object({ reason: Reason });

/**
 * One charge row (O-01). The office serializer drops `guestPhone` and `guestPhoto`
 * entirely — the keys are absent, not null (SDD §3.4, TC-SEC-03).
 */
export interface AdminChargeDTO {
  id: string;
  resident: { id: string; name: string; room: string };
  kind: 'overnight_room' | 'guest_room' | 'fine';
  amountInr: number;
  description: string;
  status: 'pending' | 'confirmed' | 'paid' | 'waived';
  createdAt: string;
  receiptNo: string | null;
  waiveReason: string | null;
  visit: {
    id: string;
    code: string;
    guestName: string;
    guestPhone?: string | null;
    guestPhoto?: PhotoDTO | null;
  } | null;
}

export const AuditQuerySchema = z.object({
  entity: z.string().max(40).optional(),
  entityId: Uuid.optional(),
  actorId: Uuid.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface AuditRowDTO {
  id: number;
  at: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  after: unknown;
}

export const ReportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export interface ReportDTO {
  from: string;
  to: string;
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  flags: { overstay: number; disputed: number; locationUnverified: number; forced: number };
}

/** SSE events (SDD §9.9). */
export type StreamEvent =
  { t: 'visit'; id: string; s: string } | { t: 'gate'; id: string; online: boolean };
