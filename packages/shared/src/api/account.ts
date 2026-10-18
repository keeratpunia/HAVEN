import { z } from 'zod';

/** SDD §12.4 `POST /me/deletion-request` — body `{ reason? }`, response 202 (§16.6). */
export const DeletionRequestBodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type DeletionRequestBody = z.infer<typeof DeletionRequestBodySchema>;

/** Why a recorded deletion hasn't happened yet (§16.6 steps 2 and 4). */
export type DeletionWaitingFor = 'inside' | 'upcoming_visit' | 'unpaid_charges';

/**
 * The 202 body. The SDD gives only the status code; the app needs to tell the person
 * whether their deletion waits for a visit to end ("shown to the user", §16.6 step 2),
 * so the response says so (docs/DECISIONS.md DEC-015).
 */
export interface DeletionRequestDTO {
  status: 'pending' | 'completed';
  waitingFor: DeletionWaitingFor | null;
  /** When the visit it waits for ends (ISO), if it waits for one. */
  waitUntil: string | null;
}

/** `details` of the 409 CONFLICT when a resident still owes charges (§16.6 step 4). */
export interface UnpaidChargesDetails {
  reason: 'UNPAID_CHARGES';
  unpaidInr: number;
}
