import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { generateGateToken } from '../src/gate/token.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, goodLocation } from './app-test-helpers.js';
import { hostelWorld, type HostelWorld } from './staff-fixtures.js';

/**
 * FR-27: "If GPS fails 3 times or permission is denied, the guest can ask the host to
 * confirm". F3 step 1 lists the two triggers separately; §9.3: "Permission denied,
 * unavailable or timeout -> send location: null with locationError". A denial is not
 * a failed GPS fix, so it is not one of the three attempts. FINAL-QA-REPORT item 8.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z');
let clock: FakeClock;
let app: FastifyInstance;
let w: HostelWorld;

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
});

const attempts = async (id: string) =>
  (
    await db
      .selectFrom('haven.scan_sessions')
      .select('location_attempts')
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  ).location_attempts;

const far = () => ({ ...goodLocation(), lat: goodLocation().lat + 1 });

describe('location permission denied (FR-27, F3, §9.3)', () => {
  it('a session opened with permission denied uses none of the three attempts', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const token = generateGateToken({ secret: w.gate.secret, gateCode: w.gate.code, now: NOW });
    const created = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: nonce, location: null, locationError: 'denied' });
    expect(created.status).toBe(201);
    expect(created.body.gpsOk).toBe(false);
    const id = created.body.scanSessionId as string;
    expect(await attempts(id)).toBe(0);

    const retry = (body: object) =>
      supertest(app.server)
        .post(`/v1/scan-sessions/${id}/location`)
        .set('X-Scan-Nonce', nonce)
        .send(body);

    // Denying again on a retry doesn't count either.
    expect((await retry({ location: null, locationError: 'denied' })).status).toBe(200);
    expect(await attempts(id)).toBe(0);

    // Once allowed, the guest still has all three real GPS attempts.
    for (const n of [1, 2, 3]) {
      const r = await retry({ location: far() });
      expect(r.status).toBe(200);
      expect(r.body.gpsFailure).toBe('outside_geofence');
      expect(await attempts(id)).toBe(n);
    }
    const fourth = await retry({ location: far() });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('LOCATION_RETRY_LIMIT');
  });

  it('any other missing location (timeout, unavailable) still counts', async () => {
    const nonce = `nonce-${randomUUID()}`;
    const token = generateGateToken({ secret: w.gate.secret, gateCode: w.gate.code, now: NOW });
    const created = await supertest(app.server)
      .post('/v1/scan-sessions')
      .send({ token, clientNonce: nonce, location: null, locationError: 'timeout' });
    expect(created.status).toBe(201);
    const id = created.body.scanSessionId as string;
    expect(await attempts(id)).toBe(1);
    await supertest(app.server)
      .post(`/v1/scan-sessions/${id}/location`)
      .set('X-Scan-Nonce', nonce)
      .send({ location: null, locationError: 'unavailable' });
    expect(await attempts(id)).toBe(2);
  });
});
