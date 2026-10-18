import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FakeClock } from '../src/lib/clock.js';
import { JobRunner } from '../src/jobs/runner.js';
import { generateVisitCode } from '../src/lib/ids.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { db, FakePushSender, MemoryMediaStorage } from './app-test-helpers.js';
import { hostelWorld, type HostelWorld } from './staff-fixtures.js';

/**
 * SDD §16.5 retention schedule, one test per row, enforced by job_retention (03:00 IST)
 * and the API-side media purge (§11.8: "the API worker deletes the files"). Scan
 * sessions and OTP challenges (§16.5 rows 1–2) are in jobs-runner.integration.test.ts;
 * the resident ID card (deleted synchronously at the decision) is in
 * staff-behaviour.integration.test.ts (FR-05).
 */

const DAY = 86_400_000;
const NOW = new Date('2026-10-18T21:30:00.000Z'); // 03:00 IST on 19 Oct
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY + extraMs);

let clock: FakeClock;
let storage: MemoryMediaStorage;
let runner: JobRunner;
let w: HostelWorld;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  storage = new MemoryMediaStorage();
  runner = new JobRunner({ db, clock, push: new FakePushSender(), mediaStorage: storage });
  w = await hostelWorld();
});

async function photo(p: {
  kind: 'gate_photo' | 'visitor_profile';
  visitorId: string;
  createdAt: Date;
}): Promise<{ id: string; path: string }> {
  const path = `${p.kind}/${randomUUID()}.jpg`;
  await storage.put(path, Buffer.from('jpeg'));
  const row = await db
    .insertInto('haven.media')
    .values({
      kind: p.kind,
      bucket: p.kind === 'gate_photo' ? 'gate-photos' : 'visitor-photos',
      path,
      sha256: Buffer.from(randomUUID()),
      bytes: 4,
      owner_visitor_id: p.visitorId,
      created_at: p.createdAt.toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, path };
}

async function guest(lastVisitAt: Date | null, name = 'Asha Rani'): Promise<string> {
  const row = await db
    .insertInto('haven.visitors')
    .values({
      phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      full_name: name,
      gender: 'female',
      last_visit_at: lastVisitAt?.toISOString() ?? null,
      created_at: (lastVisitAt ?? ago(400)).toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function visit(p: {
  visitorId: string;
  windowStart: Date;
  windowEnd: Date;
  status: 'approved' | 'completed';
  createdAt?: Date;
}) {
  const row = await db
    .insertInto('haven.visits')
    .values({
      code: generateVisitCode(),
      hostel_id: w.hostelId,
      host_id: w.residentId,
      visitor_id: p.visitorId,
      invited_name: 'Asha Rani',
      invited_phone: '+919812300042',
      invited_gender: 'female',
      type: 'day',
      status: p.status,
      origin: 'invite',
      zone: 'visitors_room',
      window_start: p.windowStart.toISOString(),
      window_end: p.windowEnd.toISOString(),
      rules_version: 1,
      created_by_type: 'user',
      created_by_id: w.residentId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (p.createdAt) {
    await sql`update haven.visits set created_at = ${p.createdAt} where id = ${row.id}`.execute(db);
  }
  return row.id;
}

const media = (id: string) =>
  db
    .selectFrom('haven.media')
    .select(['delete_after', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('§16.5 retention (job_retention + media purge)', () => {
  it('gate photos: delete_after = created_at + 180 days; the file is deleted and deleted_at set', async () => {
    const g = await guest(ago(10));
    const old = await photo({ kind: 'gate_photo', visitorId: g, createdAt: ago(180) });
    const young = await photo({ kind: 'gate_photo', visitorId: g, createdAt: ago(180, 60_000) });

    await runner.run('job_retention');
    expect(await media(old.id)).toEqual({ delete_after: NOW, deleted_at: NOW });
    expect(await storage.get(old.path)).toBeNull();
    expect((await media(young.id)).deleted_at).toBeNull();
    expect(await storage.get(young.path)).not.toBeNull();

    clock.set(new Date(NOW.getTime() + 60_000));
    await runner.run('media_purge'); // the hourly purge picks it up when it falls due
    expect(await storage.get(young.path)).toBeNull();
  });

  it('guest profile photo: deleted 365 days after last_visit_at — moved forward when the guest comes back', async () => {
    const gone = await guest(ago(365));
    const goneProfile = await photo({
      kind: 'visitor_profile',
      visitorId: gone,
      createdAt: ago(500),
    });
    const back = await guest(ago(300));
    const backProfile = await photo({
      kind: 'visitor_profile',
      visitorId: back,
      createdAt: ago(500),
    });

    await runner.run('job_retention');
    expect(await storage.get(goneProfile.path)).toBeNull();
    expect((await media(goneProfile.id)).deleted_at).toEqual(NOW);
    expect((await media(backProfile.id)).delete_after).toEqual(
      new Date(ago(300).getTime() + 365 * DAY),
    );

    // The guest checks in today: the entry moves last_visit_at, and the next run moves
    // the photo's date with it.
    const visitId = await visit({
      visitorId: back,
      windowStart: NOW,
      windowEnd: new Date(NOW.getTime() + DAY / 12),
      status: 'approved',
    });
    await db
      .insertInto('haven.gate_events')
      .values({
        visit_id: visitId,
        hostel_id: w.hostelId,
        gate_id: w.gate.gateId,
        kind: 'entry',
        actor_type: 'visitor',
        actor_id: back,
        location_verified: true,
        at: NOW.toISOString(),
      })
      .execute();
    const visitor = await db
      .selectFrom('haven.visitors')
      .select('last_visit_at')
      .where('id', '=', back)
      .executeTakeFirstOrThrow();
    expect(visitor.last_visit_at).toEqual(NOW);

    clock.set(new Date(NOW.getTime() + 65 * DAY + 1));
    await runner.run('job_retention');
    expect((await media(backProfile.id)).delete_after).toEqual(new Date(NOW.getTime() + 365 * DAY));
    expect(await storage.get(backProfile.path)).not.toBeNull();
  });

  it('guest identity: 365 days after the last visit with no future visits → "Former guest", phone null', async () => {
    const lapsed = await guest(ago(365), 'Lapsed Guest');
    const recent = await guest(ago(364), 'Recent Guest');
    const booked = await guest(ago(400), 'Booked Guest');
    await visit({
      visitorId: booked,
      windowStart: new Date(NOW.getTime() + 2 * DAY),
      windowEnd: new Date(NOW.getTime() + 2 * DAY + 3_600_000),
      status: 'approved',
    });
    // A visit in the past keeps its row; only the identity is anonymised.
    const pastVisit = await visit({
      visitorId: lapsed,
      windowStart: ago(366),
      windowEnd: ago(365),
      status: 'completed',
    });

    await runner.run('job_retention');
    const rows = await db
      .selectFrom('haven.visitors')
      .select(['id', 'full_name', 'phone', 'anonymised_at'])
      .where('id', 'in', [lapsed, recent, booked])
      .execute();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[lapsed]).toMatchObject({
      full_name: 'Former guest',
      phone: null,
      anonymised_at: NOW,
    });
    expect(byId[recent]).toMatchObject({ full_name: 'Recent Guest', anonymised_at: null });
    expect(byId[booked]).toMatchObject({ full_name: 'Booked Guest', anonymised_at: null });
    const kept = await db
      .selectFrom('haven.visits')
      .select('visitor_id')
      .where('id', '=', pastVisit)
      .executeTakeFirstOrThrow();
    expect(kept.visitor_id).toBe(lapsed);
  });

  it('visit rows: kept 2 years, then invited_name and invited_phone nulled', async () => {
    const g = await guest(ago(10));
    const twoYears = NOW.getTime() - new Date('2024-10-18T21:30:00.000Z').getTime();
    const old = await visit({
      visitorId: g,
      windowStart: ago(800),
      windowEnd: ago(800, 3_600_000),
      status: 'completed',
      createdAt: new Date(NOW.getTime() - twoYears),
    });
    const young = await visit({
      visitorId: g,
      windowStart: ago(700),
      windowEnd: ago(700, 3_600_000),
      status: 'completed',
      createdAt: new Date(NOW.getTime() - twoYears + 60_000),
    });

    await runner.run('job_retention');
    const rows = await db
      .selectFrom('haven.visits')
      .select(['id', 'invited_name', 'invited_phone'])
      .where('id', 'in', [old, young])
      .execute();
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.invited_name, r.invited_phone]]))).toEqual({
      [old]: [null, null],
      [young]: ['Asha Rani', '+919812300042'],
    });
  });

  it('audit log: kept 2 years, then purged; otherwise still append-only', async () => {
    const insert = (at: Date) =>
      db
        .insertInto('haven.audit_log')
        .values({ at: at.toISOString(), actor_type: 'system', action: 'test.row', entity: 'test' })
        .returning('id')
        .executeTakeFirstOrThrow();
    const old = await insert(new Date('2024-10-18T21:30:00.000Z'));
    const young = await insert(new Date('2024-10-18T21:31:00.000Z'));

    await runner.run('job_retention');
    const left = await db
      .selectFrom('haven.audit_log')
      .select('id')
      .where('action', '=', 'test.row')
      .execute();
    expect(left.map((r) => String(r.id))).toEqual([String(young.id)]);
    expect(left.map((r) => String(r.id))).not.toContain(String(old.id));
    await expect(
      sql`delete from haven.audit_log where action = 'test.row'`.execute(db),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`update haven.audit_log set action = 'x' where action = 'test.row'`.execute(db),
    ).rejects.toThrow(/append-only/);
  });

  it('notifications: bodies nulled after 90 days (title and data too)', async () => {
    const insert = (createdAt: Date) =>
      db
        .insertInto('haven.notifications')
        .values({
          recipient_type: 'user',
          recipient_id: w.residentId,
          kind: 'N-ARRIVED',
          channel: 'push',
          title: 'Asha Rani has arrived',
          body: 'Checked in at 4:42 pm. Tap if this isn’t your guest.',
          data: JSON.stringify({ screen: '/visit/x' }),
          status: 'sent',
          created_at: createdAt.toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const old = await insert(ago(90));
    const young = await insert(ago(90, 60_000));

    await runner.run('job_retention');
    const rows = await db
      .selectFrom('haven.notifications')
      .select(['id', 'title', 'body', 'data'])
      .where('id', 'in', [old.id, young.id])
      .execute();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[old.id]).toMatchObject({ title: null, body: '', data: {} });
    expect(byId[young.id]).toMatchObject({ title: 'Asha Rani has arrived' });
  });

  it('SMS rows past 90 days lose their recipient phone too, once they can no longer be sent (DEC-016)', async () => {
    const sms = (createdAt: Date, status: 'sent' | 'queued') =>
      db
        .insertInto('haven.notifications')
        .values({
          recipient_type: 'phone',
          recipient_phone: '+919812300077',
          kind: 'N-OVERSTAY-GUEST',
          channel: 'sms',
          body: 'Your HAVEN visit ended at 4:30 pm. Please check out at the gate now.',
          sms_template_id: 'HAVEN_OVERSTAY',
          status,
          created_at: createdAt.toISOString(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const oldSent = await sms(ago(90), 'sent');
    const youngSent = await sms(ago(90, 60_000), 'sent');

    await runner.run('job_retention');
    const rows = await db
      .selectFrom('haven.notifications')
      .select(['id', 'recipient_phone', 'body'])
      .where('id', 'in', [oldSent.id, youngSent.id])
      .execute();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[oldSent.id]).toMatchObject({ recipient_phone: null, body: '' });
    expect(byId[youngSent.id]?.recipient_phone).toBe('+919812300077');
    // A row that can still be sent must keep its phone: the constraint still holds there.
    const queued = await sms(ago(1), 'queued');
    await expect(
      db
        .updateTable('haven.notifications')
        .set({ recipient_phone: null })
        .where('id', '=', queued.id)
        .execute(),
    ).rejects.toThrow(/notifications_check/);
  });

  it('records what it did in the audit log, without personal data (FR-74)', async () => {
    await guest(ago(365));
    await runner.run('job_retention');
    const row = await db
      .selectFrom('haven.audit_log')
      .select(['actor_type', 'action', 'after'])
      .where('action', '=', 'job.retention')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      actor_type: 'system',
      after: expect.objectContaining({ guestsAnonymised: 1 }),
    });
    expect(JSON.stringify(row.after)).not.toMatch(/\+91|Asha/);
  });
});
