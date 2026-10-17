import { z } from 'zod';

/** Resident onboarding and account contracts (SDD §12.4, §12.5, flow F7). */

export const RoomNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,8}$/, 'Room numbers use letters, digits and "-" (up to 8).');

export const ResidentMeBodySchema = z.object({
  hostelId: z.string().uuid(),
  room: RoomNumberSchema,
});

export const ResidentDocumentKindSchema = z.enum(['id_card', 'selfie']);
export type ResidentDocumentKind = z.infer<typeof ResidentDocumentKindSchema>;

export type ResidentStatus = 'pending' | 'verified' | 'rejected' | 'suspended' | 'left';

/** The resident half of `GET /me` for a user principal — what R-02..R-04 and R-15 show. */
export interface ResidentProfileDTO {
  hostelId: string;
  hostelName: string;
  room: string;
  status: ResidentStatus;
  submittedAt: string | null;
  hasIdCard: boolean;
  hasSelfie: boolean;
  rejectionReason: string | null;
  canResubmit: boolean;
  hostingSuspendedUntil: string | null;
}

export interface MeUserDTO {
  type: 'user';
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  phoneVerified: boolean;
  roles: { h: string; r: 'super_admin' | 'warden' | 'office' }[];
  residentStatus: ResidentStatus | null;
  resident: ResidentProfileDTO | null;
}

export const QuotaQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

export interface QuotaDTO {
  month: string;
  used: number;
  limit: number;
  remaining: number;
}

export const ChargesQuerySchema = z.object({
  status: z.enum(['pending', 'confirmed', 'paid', 'waived']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export interface ChargeDTO {
  id: string;
  kind: 'overnight_room' | 'guest_room' | 'fine';
  amountInr: number;
  description: string;
  status: 'pending' | 'confirmed' | 'paid' | 'waived';
  visitId: string | null;
  createdAt: string;
  receiptNo: string | null;
}
