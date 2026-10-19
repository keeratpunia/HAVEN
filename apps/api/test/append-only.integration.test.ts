import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAllHavenTables } from './db-test-helper.js';
import { db } from './app-test-helpers.js';
import { hostelWorld, seedVisit } from './staff-fixtures.js';

/**
 * SDD §10.2: gate_events, audit_log, approvals and hostel_rules are append-only at the
 * database level, refused with 42501. approvals and hostel_rules used to fail with
 * 42703 instead (haven.forbid_mutation read `old.at`, a column only audit_log has) —
 * found by the first real pgTAP run (supabase/tests/002, FINAL-QA-REPORT item 10).
 */

beforeEach(async () => {
  await resetAllHavenTables();
});

async function sqlState(statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await statement.execute(db);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

describe('append-only tables refuse UPDATE and DELETE with 42501 (§10.2)', () => {
  it('approvals and hostel_rules', async () => {
    const w = await hostelWorld();
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'approved',
      windowStart: new Date(),
      windowEnd: new Date(Date.now() + 3_600_000),
    });
    await db
      .insertInto('haven.approvals')
      .values({
        visit_id: visitId,
        approver_id: w.residentId,
        approver_role: 'host',
        decision: 'approved',
      })
      .execute();

    expect(await sqlState(sql`update haven.approvals set decision = 'rejected'`)).toBe('42501');
    expect(await sqlState(sql`delete from haven.approvals`)).toBe('42501');
    expect(await sqlState(sql`update haven.hostel_rules set version = version + 100`)).toBe(
      '42501',
    );
    expect(await sqlState(sql`delete from haven.hostel_rules`)).toBe('42501');
  });
});
