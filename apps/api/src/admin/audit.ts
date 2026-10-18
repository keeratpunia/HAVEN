import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';

/**
 * Explicit audit rows for staff actions (FR-74: "Every state change and admin action is
 * written to the append-only audit log"; SDD §16.4 "Audit of reads"). Table triggers
 * already record the row-level change for the tables they cover; this adds the named
 * action — `admin.residents.verify`, `read.emergency` — with its reason, so W-11 shows
 * who did what and why, including actions on tables without a trigger (users, sessions,
 * media). Never pass raw PII in `detail` (CLAUDE.md §4): ids, reasons and counts only.
 */
export interface AuditEntry {
  actorId: string;
  hostelId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  requestId?: string | null;
}

export async function writeAudit(
  db: Kysely<Database> | Transaction<Database>,
  e: AuditEntry,
): Promise<void> {
  await db
    .insertInto('haven.audit_log')
    .values({
      actor_type: 'user',
      actor_id: e.actorId,
      hostel_id: e.hostelId,
      action: e.action,
      entity: e.entity,
      entity_id: e.entityId ?? null,
      before: null,
      after: e.detail ? JSON.stringify(e.detail) : null,
      ip: e.ip ?? null,
      request_id: e.requestId ?? null,
    })
    .execute();
}
