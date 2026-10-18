import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { JobRunner } from '../src/jobs/runner.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { sql } from 'kysely';
import { db } from './app-test-helpers.js';
import { hostelWorld, seedVisit } from './staff-fixtures.js';

/** DEC-014: the SDD §9.8 jobs run in-process when pg_cron isn't installed. */
describe('JobRunner (pg_cron fallback)', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('starts only without pg_cron, and runs each job on its SDD cadence', async () => {
    const clock = new FakeClock(new Date('2026-10-12T06:30:00.000Z')); // 12:00 IST
    const runner = new JobRunner({ db, clock });
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
      ]),
    );
    expect(first).not.toContain('job_night_sweep'); // 22:00 IST, not yet
    expect(await runner.tick()).toEqual(['job_expire_walkins']); // minute 1: only the every-minute job

    clock.set(new Date('2026-10-12T16:31:00.000Z')); // 22:01 IST
    expect(await runner.tick()).toContain('job_night_sweep');
    expect(await runner.tick()).not.toContain('job_night_sweep'); // once per day
  });

  it('TC-JOB-01: overstay job twice in a row → one host push, one guest SMS (dedupe)', async () => {
    const w = await hostelWorld();
    // job_flag_overstays compares with the database clock (now()), so the window is
    // well in the real past.
    const visit = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'inside',
      windowStart: new Date('2020-01-01T04:00:00.000Z'),
      windowEnd: new Date('2020-01-01T06:00:00.000Z'),
    });
    await sql`select haven.job_flag_overstays()`.execute(db);
    await sql`select haven.job_flag_overstays()`.execute(db);
    const rows = await db
      .selectFrom('haven.notifications')
      .select(['kind', 'channel', 'body'])
      .where('visit_id', '=', visit)
      .orderBy('kind')
      .execute();
    expect(rows).toEqual([
      {
        kind: 'N-OVERSTAY-GUEST',
        channel: 'sms',
        body: expect.stringMatching(
          /^Your HAVEN visit to VH\d+ ended at 11:30 am\. Please check out at the gate now\.$/,
        ),
      },
      {
        kind: 'N-OVERSTAY-HOST',
        channel: 'push',
        body: 'Their visit ended at 11:30 am. Ask them to check out at the gate.',
      },
    ]);
  });
});
