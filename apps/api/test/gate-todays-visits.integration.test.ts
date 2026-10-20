import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken, scanAndPhoto } from './app-test-helpers.js';
import { hostelWorld, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVerifiedHost } from './visits-fixtures.js';

/**
 * FR-23: "If the guest has an approved visit for today at this hostel, the app offers
 * Check in". E-06: "Same guest invited by two hosts on one day — Gate landing lists both
 * visits; guest picks one. Only one can be inside at a time." FINAL-QA-REPORT item 7.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST, Monday
const HOUR = 3_600_000;
let clock: FakeClock;
let app: FastifyInstance;
let w: HostelWorld;
let bearer: string;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock);
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  clock.set(NOW);
  w = await hostelWorld();
  bearer = await issueToken(clock, { type: 'visitor', id: w.visitorId });
});

const approved = (hostId: string, startOffsetH: number, endOffsetH: number) =>
  seedVisit({
    hostelId: w.hostelId,
    hostId,
    visitorId: w.visitorId,
    status: 'approved',
    windowStart: new Date(NOW.getTime() + startOffsetH * HOUR),
    windowEnd: new Date(NOW.getTime() + endOffsetH * HOUR),
  });

async function landing() {
  const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
  const res = await supertest(app.server)
    .get(`/v1/scan-sessions/${scan.sessionId}`)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Scan-Nonce', scan.nonce);
  expect(res.status).toBe(200);
  return { scan, body: res.body as { actions: string[]; visits: { id: string }[] } };
}

describe('the gate lists every approved visit for today (FR-23, E-06)', () => {
  it('two hosts invite the same guest today: both are listed and the guest checks in to the one they pick', async () => {
    const secondHost = await makeVerifiedHost(db, w.hostelId);
    const first = await approved(w.residentId, -1, 2); // 11:00–14:00 IST
    const second = await approved(secondHost, -0.5, 4); // 11:30–16:00 IST

    const { scan, body } = await landing();
    expect(body.actions).toEqual(['check_in']);
    expect(body.visits.map((v) => v.id)).toEqual([first, second]);

    // The guest picks the second host's visit.
    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', randomUUID())
      .send({ visitId: second, photoId: scan.photoId });
    expect(res.status).toBe(200);
    expect(res.body.visit.id).toBe(second);
    expect(res.body.result).toBe('inside');

    // Only one can be inside: the next scan offers check-out of that one only.
    const next = await landing();
    expect(next.body.actions).toEqual(['check_out']);
    expect(next.body.visits.map((v) => v.id)).toEqual([second]);
  });

  it("each listed visit names the host and hostel, for check-in and for check-out (G-08 'Visiting <host>')", async () => {
    // Found in the report screenshots: the gate page read "Visiting  until 4:15pm" because
    // this response carried the bare VisitDTO without the host's first name.
    const id = await approved(w.residentId, -1, 2);
    const host = await db
      .selectFrom('haven.users')
      .select('full_name')
      .where('id', '=', w.residentId)
      .executeTakeFirstOrThrow();
    const hostel = await db
      .selectFrom('haven.hostels')
      .select('name')
      .where('id', '=', w.hostelId)
      .executeTakeFirstOrThrow();
    const expected = { id, hostFirstName: host.full_name.split(' ')[0], hostelName: hostel.name };

    const { scan, body } = await landing();
    expect(body.actions).toEqual(['check_in']);
    expect(body.visits).toEqual([expect.objectContaining(expected)]);

    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', randomUUID())
      .send({ visitId: id, photoId: scan.photoId });
    expect(res.status).toBe(200);

    const next = await landing();
    expect(next.body.actions).toEqual(['check_out']);
    expect(next.body.visits).toEqual([expect.objectContaining(expected)]);
  });

  it('an approved visit for a later day is not offered Check in today', async () => {
    await approved(w.residentId, 24, 27); // tomorrow 12:00–15:00 IST
    const { body } = await landing();
    expect(body.actions).toEqual(['request_entry']);
    expect(body.visits).toEqual([]);
  });

  it('a visit whose window already ended is not offered; one later today is', async () => {
    await approved(w.residentId, -4, -1); // 08:00–11:00 IST, over
    const later = await approved(w.residentId, 6, 9); // 18:00–21:00 IST
    const { body } = await landing();
    expect(body.actions).toEqual(['check_in']);
    expect(body.visits.map((v) => v.id)).toEqual([later]);
  });

  it('"today" is the IST day: at 23:30 IST a visit starting 00:30 IST is tomorrow', async () => {
    clock.set(new Date('2026-10-12T18:00:00.000Z')); // 23:30 IST
    bearer = await issueToken(clock, { type: 'visitor', id: w.visitorId });
    await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'approved',
      windowStart: new Date('2026-10-12T19:00:00.000Z'), // 00:30 IST on the 13th
      windowEnd: new Date('2026-10-12T21:00:00.000Z'),
    });
    const { body } = await landing();
    expect(body.actions).toEqual(['request_entry']);
  });
});
