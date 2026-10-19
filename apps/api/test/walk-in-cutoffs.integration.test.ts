import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copyFor } from '@haven/shared';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, idem, issueToken, scanAndPhoto } from './app-test-helpers.js';
import { hostelWorld, type HostelWorld } from './staff-fixtures.js';

/**
 * FINAL-QA-REPORT D-01: walk-ins must obey the entry cut-offs.
 * BR-02 "Day and quick drop-off guests must check in before 20:00", BR-03 "No guest of
 * any type may check in at or after 22:00", F2 step 9 (evaluateEntry on approval) and
 * E-05 "Walk-in requested 19:58, approved 20:03 → allowed: entry cut-offs are judged at
 * the scan session's created_at".
 */

const ist = (t: string) => new Date(`2026-10-12T${t}+05:30`);
let clock: FakeClock;
let app: FastifyInstance;
let w: HostelWorld;

beforeAll(async () => {
  clock = new FakeClock(ist('12:00:00'));
  app = await buildTestApp(clock);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  w = await hostelWorld();
});

async function requestWalkIn(at: string, type: 'day' | 'quick_drop' = 'day') {
  clock.set(ist(at));
  const bearer = await issueToken(clock, { type: 'visitor', id: w.visitorId });
  const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
  return supertest(app.server)
    .post(`/v1/scan-sessions/${scan.sessionId}/walk-in`)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Scan-Nonce', scan.nonce)
    .send({
      hostId: w.residentId,
      type,
      durationMinutes: type === 'day' ? 60 : 15,
      photoId: scan.photoId,
    });
}

async function approve(visitId: string) {
  const token = await issueToken(clock, { type: 'user', id: w.residentId });
  return supertest(app.server)
    .post(`/v1/visits/${visitId}/approve`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idem())
    .send({});
}

describe('walk-in entry cut-offs (BR-02, BR-03, E-05)', () => {
  it('a day walk-in at 19:59 IST is accepted', async () => {
    const res = await requestWalkIn('19:59:00');
    expect(res.status).toBe(201);
  });

  it('a day walk-in at 20:00 IST is AFTER_ENTRY_CUTOFF (BR-02), quick drop-off too', async () => {
    const day = await requestWalkIn('20:00:00');
    expect(day.status).toBe(422);
    expect(day.body.error.code).toBe('AFTER_ENTRY_CUTOFF');
    const quick = await requestWalkIn('20:30:00', 'quick_drop');
    expect(quick.body.error.code).toBe('AFTER_ENTRY_CUTOFF');
    expect(await db.selectFrom('haven.visits').select('id').execute()).toEqual([]);
  });

  it('requested at 19:58, approved at 20:03 → inside: judged at the scan (E-05)', async () => {
    const res = await requestWalkIn('19:58:00');
    expect(res.status).toBe(201);
    clock.set(ist('20:03:00'));
    const approved = await approve(res.body.visit.id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('inside');
  });

  it('an approval cannot launder a late request: a request judged after 20:00 is refused at approval', async () => {
    // A pending walk-in whose scan session is after the cut-off (e.g. created before
    // this fix) must not be admitted by approving it.
    const res = await requestWalkIn('19:59:30');
    expect(res.status).toBe(201);
    await db
      .updateTable('haven.scan_sessions')
      .set({ created_at: ist('20:10:00').toISOString() })
      .where('visit_id', '=', res.body.visit.id)
      .execute();
    clock.set(ist('20:11:00'));
    const approved = await approve(res.body.visit.id);
    expect(approved.status).toBe(422);
    expect(approved.body.error.code).toBe('AFTER_ENTRY_CUTOFF');
    const v = await db
      .selectFrom('haven.visits')
      .select('status')
      .where('id', '=', res.body.visit.id)
      .executeTakeFirstOrThrow();
    expect(v.status).toBe('pending_host');
  });

  it('after 22:00 any walk-in is AFTER_HARD_CUTOFF, shown with the §13.6 "closed to guests" copy', async () => {
    const res = await requestWalkIn('22:30:00', 'quick_drop');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AFTER_HARD_CUTOFF');
    expect(copyFor(res.body.error.code)).toEqual({
      title: 'The hostel is closed to guests',
      body: 'No guests can enter after 10:00 pm.',
    });
  });
});
