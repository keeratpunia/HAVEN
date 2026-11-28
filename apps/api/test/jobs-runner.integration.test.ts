import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FakeClock } from '../src/lib/clock.js';
import { JobRunner, SDD_JOBS } from '../src/jobs/runner.js';
import { NotificationWorker } from '../src/notify/worker.js';
import { personalDataIn } from '../src/notify/sending-rules.js';
import { generateVisitCode } from '../src/lib/ids.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { db, FakePushSender, FakeSmsSender, MemoryMediaStorage } from './app-test-helpers.js';
import { grant, hostelWorld, makeUser, type HostelWorld } from './staff-fixtures.js';
import { makeVerifiedHost, makeVisitor } from './visits-fixtures.js';

/**
 * SDD §9.8 / §11.8 jobs, driven through the JobRunner with an injected clock
 * (docs/DECISIONS.md DEC-015). Times are written in IST (UTC+05:30); the database stores
 * UTC.
 */

const MIN = 60_000;
const SEC = 1_000;
/** 2026-10-18 16:00 IST. */
const NOW = new Date('2026-10-18T10:30:00.000Z');
const ist = (local: string) => new Date(`${local}+05:30`);

let clock: FakeClock;
let runner: JobRunner;
let push: FakePushSender;

function newRunner() {
  push = new FakePushSender();
  return new JobRunner({ db, clock, push, mediaStorage: new MemoryMediaStorage() });
}

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  runner = newRunner();
});

async function insertVisit(p: {
  w: HostelWorld;
  hostId?: string;
  visitorId?: string;
  status: 'pending_host' | 'approved' | 'inside' | 'completed';
  type?: 'day' | 'quick_drop' | 'overnight_room';
  windowStart: Date;
  windowEnd: Date;
  createdAt?: Date;
  entered?: boolean;
  nights?: number;
}): Promise<string> {
  const entered = p.entered ?? (p.status === 'inside' || p.status === 'completed');
  const row = await db
    .insertInto('haven.visits')
    .values({
      code: generateVisitCode(),
      hostel_id: p.w.hostelId,
      host_id: p.hostId ?? p.w.residentId,
      visitor_id: p.visitorId ?? p.w.visitorId,
      type: p.type ?? 'day',
      status: p.status,
      origin: p.status === 'pending_host' ? 'walk_in' : 'invite',
      zone: 'visitors_room',
      window_start: p.windowStart.toISOString(),
      window_end: p.windowEnd.toISOString(),
      nights: p.nights ?? 0,
      rules_version: 1,
      created_by_type: 'user',
      created_by_id: p.w.residentId,
      first_entry_at: entered ? p.windowStart.toISOString() : null,
      last_entry_at: entered ? p.windowStart.toISOString() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (p.createdAt) {
    await sql`update haven.visits set created_at = ${p.createdAt} where id = ${row.id}`.execute(db);
  }
  return row.id;
}

const notes = (kind: string) =>
  db
    .selectFrom('haven.notifications')
    .select([
      'kind',
      'channel',
      'recipient_id',
      'recipient_phone',
      'title',
      'body',
      'data',
      'dedupe_key',
    ])
    .where('kind', '=', kind)
    .orderBy('dedupe_key')
    .execute();

const status = async (id: string) =>
  await db
    .selectFrom('haven.visits')
    .select(['status', 'overstay_since', 'overstay_escalated_at', 'close_reason', 'cancel_reason'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('JobRunner', () => {
  it('starts only without pg_cron and runs each job on its SDD cadence', async () => {
    clock.set(ist('2026-10-18T12:00:00'));
    expect(await runner.start()).toBe(true); // the test Postgres has no pg_cron
    runner.stop();

    const first = await runner.tick();
    expect(first).toEqual(
      expect.arrayContaining([
        'job_expire_walkins',
        'job_expire_approved',
        'job_flag_overstays',
        'job_gate_offline',
        'job_expire_sessions',
        'job_retention',
        'media_purge',
        'push_receipts',
        'account_deletion',
      ]),
    );
    expect(first).not.toContain('job_night_sweep'); // 22:00 IST, not yet
    expect(await runner.tick()).toEqual(['job_expire_walkins']); // minute 1

    clock.set(ist('2026-10-18T21:59:00'));
    expect(await runner.tick()).not.toContain('job_night_sweep');
    clock.set(ist('2026-10-18T22:00:00'));
    expect(await runner.tick()).toContain('job_night_sweep');
    expect(await runner.tick()).not.toContain('job_night_sweep'); // once per IST day
    clock.set(ist('2026-10-19T03:00:00'));
    expect(await runner.tick()).toContain('job_retention'); // 03:00 IST, the next day
  });

  it('schedules match SDD §9.8 (and §16.6 "within 7 days" for deletion)', () => {
    const byName = Object.fromEntries(SDD_JOBS.map((j) => [j.fn, j.every ?? j.dailyIst]));
    expect(byName).toEqual({
      job_expire_walkins: 1,
      job_expire_approved: 5,
      job_flag_overstays: 5,
      job_gate_offline: 5,
      job_expire_sessions: 60,
      job_night_sweep: '22:00',
      job_retention: '03:00',
      job_daily_digest: '08:00',
      media_purge: 60,
      push_receipts: 5,
      account_deletion: 15,
    });
  });
});

describe('BR-12 / FR-70: walk-in expiry (job_expire_walkins)', () => {
  it('9:59 after the request it is still waiting; at 10:00 it expires and the host is told once', async () => {
    const w = await hostelWorld();
    const id = await insertVisit({
      w,
      status: 'pending_host',
      windowStart: NOW,
      windowEnd: new Date(NOW.getTime() + 60 * MIN),
      createdAt: new Date(NOW.getTime() - 10 * MIN + SEC),
    });
    await runner.run('job_expire_walkins');
    expect((await status(id)).status).toBe('pending_host');

    clock.advance(SEC); // exactly 10:00
    await runner.run('job_expire_walkins');
    expect(await status(id)).toMatchObject({
      status: 'expired',
      cancel_reason: 'host_no_response',
    });
    await runner.run('job_expire_walkins');
    const rows = await notes('N-WALKIN-EXPIRED');
    expect(rows).toEqual([
      expect.objectContaining({
        channel: 'push',
        recipient_id: w.residentId,
        title: 'Guest request expired',
        body: "Test Guest's request at the gate wasn't answered.",
      }),
    ]);
  });
});

describe('FR-71: approved visits never entered expire at window_end (job_expire_approved)', () => {
  it('expires at window_end exactly, waives only that visit’s pending charge, completes entered visits', async () => {
    const w = await hostelWorld();
    const due = await insertVisit({
      w,
      status: 'approved',
      type: 'overnight_room',
      nights: 2,
      windowStart: new Date(NOW.getTime() - 48 * 60 * MIN),
      windowEnd: NOW,
    });
    const notYet = await insertVisit({
      w,
      visitorId: await makeVisitor(db),
      status: 'approved',
      windowStart: NOW,
      windowEnd: new Date(NOW.getTime() + SEC),
    });
    const reentry = await insertVisit({
      w,
      visitorId: await makeVisitor(db),
      status: 'approved',
      entered: true,
      windowStart: new Date(NOW.getTime() - 60 * MIN),
      windowEnd: new Date(NOW.getTime() - MIN),
    });
    const charge = async (visitId: string) =>
      (
        await db
          .insertInto('haven.charges')
          .values({
            hostel_id: w.hostelId,
            resident_id: w.residentId,
            visit_id: visitId,
            kind: 'overnight_room',
            amount_inr: 100,
            description: 'Overnight room stay, 2 night(s).',
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const dueCharge = await charge(due);
    const otherCharge = await charge(notYet);

    await runner.run('job_expire_approved');
    expect((await status(due)).status).toBe('expired');
    expect((await status(notYet)).status).toBe('approved');
    expect(await status(reentry)).toMatchObject({
      status: 'completed',
      close_reason: 'window_ended',
    });
    const charges = await db
      .selectFrom('haven.charges')
      .select(['id', 'status', 'waive_reason'])
      .where('id', 'in', [dueCharge, otherCharge])
      .execute();
    expect(Object.fromEntries(charges.map((c) => [c.id, c.status]))).toEqual({
      [dueCharge]: 'waived',
      [otherCharge]: 'pending',
    });
  });
});

describe('BR-13 / FR-72: overstay detection and escalation (job_flag_overstays)', () => {
  it('window_end + 14:59 is not an overstay; + 15:00 is; host push + guest SMS; wardens at 30:00', async () => {
    const w = await hostelWorld();
    const secondWarden = await makeUser('Second Warden');
    await grant(secondWarden, 'warden', w.hostelId);
    const windowEnd = ist('2026-10-18T16:30:00');
    const id = await insertVisit({
      w,
      status: 'inside',
      windowStart: ist('2026-10-18T14:00:00'),
      windowEnd,
    });

    clock.set(new Date(windowEnd.getTime() + 15 * MIN - SEC));
    await runner.run('job_flag_overstays');
    expect((await status(id)).overstay_since).toBeNull();

    clock.set(new Date(windowEnd.getTime() + 15 * MIN));
    await runner.run('job_flag_overstays');
    expect((await status(id)).overstay_since).toEqual(clock.now());
    const phone = (
      await db
        .selectFrom('haven.visitors')
        .select('phone')
        .where('id', '=', w.visitorId)
        .executeTakeFirstOrThrow()
    ).phone;
    expect(await notes('N-OVERSTAY-HOST')).toEqual([
      expect.objectContaining({
        channel: 'push',
        recipient_id: w.residentId,
        title: 'Your guest is still inside',
        body: 'Their visit ended at 4:30 pm. Ask them to check out at the gate.',
      }),
    ]);
    expect(await notes('N-OVERSTAY-GUEST')).toEqual([
      expect.objectContaining({
        channel: 'sms',
        recipient_phone: phone,
        // §15.3 HAVEN_OVERSTAY, the registered DLT text.
        body: 'Your HAVEN visit ended at 4:30 pm. Please check out at the gate now.',
        data: { smsVars: ['4:30 pm'] },
      }),
    ]);

    // FR-72: "after 30 min notify warden" — not at 29:59, at 30:00, once per warden.
    clock.advance(30 * MIN - SEC);
    await runner.run('job_flag_overstays');
    expect(await notes('N-OVERSTAY-WARDEN')).toEqual([]);
    clock.advance(SEC);
    await runner.run('job_flag_overstays');
    const wardenRows = await notes('N-OVERSTAY-WARDEN');
    expect(wardenRows.map((r) => r.recipient_id).sort()).toEqual([w.wardenId, secondWarden].sort());
    expect(wardenRows[0]).toMatchObject({
      title: 'Guest overstaying',
      body: expect.stringMatching(
        /^Test Guest \(host Test Host, room R\d+\) is 30\+ min past their end time\.$/,
      ),
      data: { screen: `/warden/visits/${id}` },
    });
  });

  it('TC-JOB-01: running the job twice in a row → one host push, one guest SMS', async () => {
    const w = await hostelWorld();
    await db
      .insertInto('haven.push_tokens')
      .values({ user_id: w.residentId, expo_token: 'ExponentPushToken[host]', platform: 'android' })
      .execute();
    const id = await insertVisit({
      w,
      status: 'inside',
      windowStart: new Date(NOW.getTime() - 3 * 60 * MIN),
      windowEnd: new Date(NOW.getTime() - 20 * MIN),
    });
    await runner.run('job_flag_overstays');
    await runner.run('job_flag_overstays');
    clock.advance(5 * MIN);
    await runner.run('job_flag_overstays'); // the next scheduled run: still nothing new

    const sms = new FakeSmsSender();
    const worker = new NotificationWorker({ db, clock, push, sms });
    await worker.tick();
    await worker.tick();
    expect(push.sent.filter((m) => m.data.visitId === id)).toHaveLength(1);
    expect(sms.sent).toEqual([
      expect.objectContaining({
        templateId: 'HAVEN_OVERSTAY',
        vars: [expect.stringMatching(/ pm$/)],
      }),
    ]);
  });
});

describe('TC-JOB-02 / BR-14 / FR-73: night sweep (job_night_sweep)', () => {
  it('2 day guests + 1 overnight guest inside → wardens hear about the 2 only; hosts of the 2 are told', async () => {
    const w = await hostelWorld();
    const host2 = await makeVerifiedHost(db, w.hostelId);
    // A day guest who came in yesterday evening and never left, one from this
    // afternoon, an overnight guest, and a day guest who already left.
    const lateYesterday = await insertVisit({
      w,
      status: 'inside',
      windowStart: ist('2026-10-17T21:30:00'),
      windowEnd: ist('2026-10-17T21:59:00'),
    });
    const today = await insertVisit({
      w,
      hostId: host2,
      visitorId: await makeVisitor(db),
      status: 'inside',
      type: 'quick_drop',
      windowStart: ist('2026-10-18T21:40:00'),
      windowEnd: ist('2026-10-18T21:55:00'),
    });
    const overnight = await insertVisit({
      w,
      visitorId: await makeVisitor(db),
      status: 'inside',
      type: 'overnight_room',
      nights: 1,
      windowStart: ist('2026-10-18T18:00:00'),
      windowEnd: ist('2026-10-19T12:00:00'),
    });
    await insertVisit({
      w,
      visitorId: await makeVisitor(db),
      status: 'completed',
      windowStart: ist('2026-10-18T15:00:00'),
      windowEnd: ist('2026-10-18T17:00:00'),
    });
    // Another hostel with nobody inside gets the in-app "none" message.
    const quiet = await hostelWorld();

    clock.set(ist('2026-10-18T22:00:00'));
    await runner.run('job_night_sweep');

    const wardenRows = (await notes('N-NIGHT-SWEEP')).filter((r) => r.recipient_id === w.wardenId);
    expect(wardenRows).toHaveLength(1);
    const ids = [lateYesterday, today].sort();
    expect(wardenRows[0]).toMatchObject({
      channel: 'push',
      title: '2 day guests still inside',
      body: 'Tap to see who and whose guests they are.',
      data: { visitIds: ids, screen: `/warden/inside?ids=${ids.join(',')}` },
      dedupe_key: `night-sweep:${w.hostelId}:2026-10-18:${w.wardenId}`,
    });
    expect(JSON.stringify(wardenRows[0]?.data)).not.toContain(overnight);

    const hostRows = await notes('N-NIGHT-SWEEP-HOST');
    expect(hostRows.map((r) => r.recipient_id).sort()).toEqual([w.residentId, host2].sort());
    expect(hostRows[0]).toMatchObject({
      title: 'Your guest is still inside after 10 pm',
      body: 'Day guests must leave. The warden has been informed.',
    });

    expect((await notes('N-NIGHT-SWEEP')).filter((r) => r.recipient_id === quiet.wardenId)).toEqual(
      [expect.objectContaining({ channel: 'in_app', body: 'No day guests inside at 10 pm' })],
    );

    // Around midnight IST: a second run before midnight adds nothing; the dedupe key is
    // the IST date, which changes at 00:00 IST (18:30 UTC — still "today" in UTC).
    clock.set(ist('2026-10-18T23:59:59'));
    await runner.run('job_night_sweep');
    expect(
      (await notes('N-NIGHT-SWEEP')).filter((r) => r.recipient_id === w.wardenId),
    ).toHaveLength(1);
    clock.set(ist('2026-10-19T00:00:30'));
    expect(clock.now().toISOString().slice(0, 10)).toBe('2026-10-18');
    await runner.run('job_night_sweep');
    const keys = (await notes('N-NIGHT-SWEEP'))
      .filter((r) => r.recipient_id === w.wardenId)
      .map((r) => r.dedupe_key);
    expect(keys).toEqual([
      `night-sweep:${w.hostelId}:2026-10-18:${w.wardenId}`,
      `night-sweep:${w.hostelId}:2026-10-19:${w.wardenId}`,
    ]);
  });
});

describe('FR-29 / §15.5: gate offline, at most one push per outage (job_gate_offline)', () => {
  it('alerts every warden once after 5 min of silence, and again only after the next outage', async () => {
    const w = await hostelWorld();
    const secondWarden = await makeUser('Second Warden');
    await grant(secondWarden, 'warden', w.hostelId);
    const device = await db
      .insertInto('haven.gate_devices')
      .values({
        gate_id: w.gate.gateId,
        token_hash: Buffer.from('device-token-hash'),
        paired_by: w.wardenId,
        last_seen_at: ist('2026-10-18T15:55:00').toISOString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    clock.set(ist('2026-10-18T16:00:00')); // silent exactly 5 min: not yet
    await runner.run('job_gate_offline');
    expect(await notes('N-GATE-OFFLINE')).toEqual([]);

    clock.set(ist('2026-10-18T16:00:01'));
    await runner.run('job_gate_offline');
    clock.advance(5 * MIN);
    await runner.run('job_gate_offline');
    const first = await notes('N-GATE-OFFLINE');
    expect(first.map((r) => r.recipient_id).sort()).toEqual([w.wardenId, secondWarden].sort());
    expect(first[0]).toMatchObject({
      title: 'Gate screen offline',
      body: expect.stringMatching(/ hasn't checked in since 3:55 pm\. Guests can't scan in\.$/),
      data: { screen: '/warden/gates' },
    });

    // Back online, then silent again: a new outage, one more alert per warden.
    await db
      .updateTable('haven.gate_devices')
      .set({ last_seen_at: ist('2026-10-18T16:10:00').toISOString() })
      .where('id', '=', device.id)
      .execute();
    clock.set(ist('2026-10-18T16:20:00'));
    await runner.run('job_gate_offline');
    await runner.run('job_gate_offline');
    expect(await notes('N-GATE-OFFLINE')).toHaveLength(4);
  });
});

describe('FR-60: daily digest at 08:00 IST (job_daily_digest, DEC-016)', () => {
  it("counts yesterday's IST day for each warden, once per day, and opens W-12 for that day", async () => {
    const w = await hostelWorld();
    const secondWarden = await makeUser('Second Warden');
    await grant(secondWarden, 'warden', w.hostelId);
    // Yesterday (17 Oct, IST): two entries, one unverified; one dispute, one overstay,
    // one forced check-out. Plus one entry just before and one just after that day.
    const day = async (start: string, extra: Record<string, unknown> = {}) => {
      const id = await insertVisit({
        w,
        visitorId: await makeVisitor(db),
        status: 'completed',
        windowStart: ist(start),
        windowEnd: new Date(ist(start).getTime() + 60 * MIN),
      });
      if (Object.keys(extra).length > 0) {
        await db.updateTable('haven.visits').set(extra).where('id', '=', id).execute();
      }
      return id;
    };
    const a = await day('2026-10-17T00:10:00', {
      host_disputed_at: ist('2026-10-17T00:20:00').toISOString(),
    });
    const b = await day('2026-10-17T23:50:00', {
      overstay_since: ist('2026-10-17T23:55:00').toISOString(),
      close_reason: 'forced',
      closed_at: ist('2026-10-17T23:59:00').toISOString(),
    });
    await day('2026-10-16T23:59:00');
    await day('2026-10-18T00:00:00');
    for (const [visitId, verified] of [
      [a, true],
      [b, false],
    ] as const) {
      await db
        .insertInto('haven.gate_events')
        .values({
          visit_id: visitId,
          hostel_id: w.hostelId,
          gate_id: w.gate.gateId,
          kind: 'entry',
          actor_type: 'visitor',
          location_verified: verified,
          at: (visitId === a
            ? ist('2026-10-17T00:10:00')
            : ist('2026-10-17T23:50:00')
          ).toISOString(),
        })
        .execute();
    }

    clock.set(ist('2026-10-18T07:59:00'));
    expect(await runner.tick()).not.toContain('job_daily_digest');
    clock.set(ist('2026-10-18T08:00:00'));
    expect(await runner.tick()).toContain('job_daily_digest');
    await runner.run('job_daily_digest'); // a second run the same day adds nothing

    const rows = await notes('N-DIGEST');
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([w.wardenId, secondWarden].sort());
    const code = (
      await db
        .selectFrom('haven.hostels')
        .select('code')
        .where('id', '=', w.hostelId)
        .executeTakeFirstOrThrow()
    ).code;
    expect(rows[0]).toMatchObject({
      channel: 'push',
      title: `Yesterday at ${code}`,
      // DEC-033: a dispute left from before the change is no longer counted.
      body: '2 visits · 1 overstayed · 1 location not verified · 1 forced check-outs.',
      data: { screen: '/warden/reports?from=2026-10-17&to=2026-10-17' },
    });
  });
});

describe('§16.5 ephemeral rows (job_expire_sessions)', () => {
  it('deletes scan sessions 1 day after expiry, OTPs after 1 day, idempotency keys after 24 h, spent pairing codes', async () => {
    const w = await hostelWorld();
    const day = 24 * 60 * MIN;
    const session = async (expiresAt: Date) =>
      (
        await db
          .insertInto('haven.scan_sessions')
          .values({
            gate_id: w.gate.gateId,
            client_nonce_hash: Buffer.from(`n-${expiresAt.getTime()}`),
            token_step: 1,
            token_age_steps: 0,
            gps_ok: false,
            expires_at: expiresAt.toISOString(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const oldSession = await session(new Date(NOW.getTime() - day));
    const recentSession = await session(new Date(NOW.getTime() - day + SEC));
    const otp = async (createdAt: Date) =>
      (
        await db
          .insertInto('haven.otp_challenges')
          .values({
            phone: '+919876543210',
            purpose: 'guest_login',
            code_hash: Buffer.from(`c-${createdAt.getTime()}`),
            expires_at: createdAt.toISOString(),
            created_at: createdAt.toISOString(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const oldOtp = await otp(new Date(NOW.getTime() - day));
    const recentOtp = await otp(new Date(NOW.getTime() - day + SEC));

    const idem = async (key: string, createdAt: Date) =>
      db
        .insertInto('haven.idempotency_keys')
        .values({
          key,
          principal_id: w.residentId,
          route: 'POST /v1/visits/:id/approve',
          status_code: 200,
          response: JSON.stringify({}),
          created_at: createdAt.toISOString(),
        })
        .execute();
    const oldKey = '00000000-0000-4000-8000-000000000001';
    const recentKey = '00000000-0000-4000-8000-000000000002';
    await idem(oldKey, new Date(NOW.getTime() - day));
    await idem(recentKey, new Date(NOW.getTime() - day + SEC));
    const code = async (hash: string, expiresAt: Date, used: boolean) =>
      db
        .insertInto('haven.gate_pairing_codes')
        .values({
          code_hash: Buffer.from(hash),
          gate_id: w.gate.gateId,
          created_by: w.wardenId,
          expires_at: expiresAt.toISOString(),
          used_at: used ? NOW.toISOString() : null,
        })
        .execute();
    await code('expired', NOW, false);
    await code('used', new Date(NOW.getTime() + 5 * MIN), true);
    await code('live', new Date(NOW.getTime() + 5 * MIN), false);

    await runner.run('job_expire_sessions');
    const keys = await db.selectFrom('haven.idempotency_keys').select('key').execute();
    expect(keys.map((k) => k.key)).toEqual([recentKey]);
    const codes = await db.selectFrom('haven.gate_pairing_codes').select('code_hash').execute();
    expect(codes.map((c) => Buffer.from(c.code_hash).toString())).toEqual(['live']);
    const sessions = await db.selectFrom('haven.scan_sessions').select('id').execute();
    expect(sessions.map((s) => s.id)).toEqual([recentSession]);
    expect(sessions.map((s) => s.id)).not.toContain(oldSession);
    const otps = await db.selectFrom('haven.otp_challenges').select('id').execute();
    expect(otps.map((o) => o.id)).toEqual([recentOtp]);
    expect(otps.map((o) => o.id)).not.toContain(oldOtp);
  });
});

describe('§15.5 across every job', () => {
  it('no push or SMS a job produced carries a phone number or a photo', async () => {
    const w = await hostelWorld();
    await insertVisit({
      w,
      status: 'inside',
      windowStart: new Date(NOW.getTime() - 3 * 60 * MIN),
      windowEnd: new Date(NOW.getTime() - 60 * MIN),
    });
    await insertVisit({
      w,
      visitorId: await makeVisitor(db),
      status: 'pending_host',
      windowStart: NOW,
      windowEnd: new Date(NOW.getTime() + 60 * MIN),
      createdAt: new Date(NOW.getTime() - 20 * MIN),
    });
    for (const job of ['job_flag_overstays', 'job_expire_walkins'] as const) await runner.run(job);
    clock.set(ist('2026-10-18T22:00:00'));
    await runner.run('job_flag_overstays');
    await runner.run('job_night_sweep');

    const rows = await db
      .selectFrom('haven.notifications')
      .select(['kind', 'title', 'body'])
      .where('channel', 'in', ['push', 'sms'])
      .execute();
    expect(new Set(rows.map((r) => r.kind))).toEqual(
      new Set([
        'N-OVERSTAY-HOST',
        'N-OVERSTAY-GUEST',
        'N-OVERSTAY-WARDEN',
        'N-WALKIN-EXPIRED',
        'N-NIGHT-SWEEP',
        'N-NIGHT-SWEEP-HOST',
      ]),
    );
    for (const r of rows) {
      expect([r.kind, personalDataIn(r.title) ?? personalDataIn(r.body)]).toEqual([r.kind, null]);
    }
  });
});
