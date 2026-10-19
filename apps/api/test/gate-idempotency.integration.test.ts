import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken, scanAndPhoto } from './app-test-helpers.js';
import { hostelWorld, seedVisit, type HostelWorld } from './staff-fixtures.js';

/**
 * SDD §9.12: "POSTs that change gate or visit state MUST carry Idempotency-Key: <uuid>:
 * check-in, check-out, walk-in ... replays the stored response on repeat." E-10 (the
 * guest taps twice / the network retries) and TC-FLOW-10: the repeat gets the identical
 * answer and only one gate event exists. FINAL-QA-REPORT item 6.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST
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

const gateEvents = (visitId: string) =>
  db.selectFrom('haven.gate_events').select(['kind']).where('visit_id', '=', visitId).execute();

async function twice(path: string, nonce: string, body: object, key = randomUUID()) {
  const send = () =>
    supertest(app.server)
      .post(path)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Scan-Nonce', nonce)
      .set('Idempotency-Key', key)
      .send(body);
  const first = await send();
  const second = await send();
  return { first, second };
}

describe('gate ★ actions replay on a repeated Idempotency-Key (§9.12, E-10, TC-FLOW-10)', () => {
  it('check-in: same status and body twice, one entry gate event', async () => {
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'approved',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + 2 * HOUR),
    });
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
    const { first, second } = await twice(
      `/v1/scan-sessions/${scan.sessionId}/check-in`,
      scan.nonce,
      {
        visitId,
        photoId: scan.photoId,
      },
    );
    expect(first.status).toBe(200);
    expect(first.body.result).toBe('inside');
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await gateEvents(visitId)).toHaveLength(1);
  });

  it('check-out: same status and body twice, one exit gate event', async () => {
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'inside',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + 2 * HOUR),
    });
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
    const { first, second } = await twice(
      `/v1/scan-sessions/${scan.sessionId}/check-out`,
      scan.nonce,
      {
        visitId,
        photoId: scan.photoId,
      },
    );
    expect(first.status).toBe(200);
    expect(first.body.visit.status).toBe('completed');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await gateEvents(visitId)).toHaveLength(1);
  });

  it('walk-in: same 201 and body twice, one visit created', async () => {
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
    const { first, second } = await twice(
      `/v1/scan-sessions/${scan.sessionId}/walk-in`,
      scan.nonce,
      {
        hostId: w.residentId,
        type: 'day',
        durationMinutes: 60,
        photoId: scan.photoId,
      },
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const visits = await db
      .selectFrom('haven.visits')
      .select('id')
      .where('visitor_id', '=', w.visitorId)
      .where('origin', '=', 'walk_in')
      .execute();
    expect(visits).toHaveLength(1);
  });

  it('the key is required on all three', async () => {
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer });
    for (const action of ['check-in', 'check-out', 'walk-in']) {
      const res = await supertest(app.server)
        .post(`/v1/scan-sessions/${scan.sessionId}/${action}`)
        .set('Authorization', `Bearer ${bearer}`)
        .set('X-Scan-Nonce', scan.nonce)
        .send(
          action === 'walk-in'
            ? { hostId: w.residentId, type: 'day', durationMinutes: 60, photoId: scan.photoId }
            : { visitId: randomUUID(), photoId: scan.photoId },
        );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});
