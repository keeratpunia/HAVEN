import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { generateGateToken } from '../src/gate/token.js';
import { resetAllHavenTables } from './db-test-helper.js';
import {
  buildTestApp,
  db,
  goodLocation,
  issueToken,
  MemoryMediaStorage,
  scanAndPhoto,
} from './app-test-helpers.js';
import { hostelWorld, pairDevice, seedVisit, type HostelWorld } from './staff-fixtures.js';
import { makeVerifiedHost } from './visits-fixtures.js';

/**
 * Behaviour that was implemented but untested (FINAL-QA-REPORT item 13): E-04, E-14,
 * E-20, E-23, E-24, FR-45 (the warden's side) and TC-FLOW-02.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST
const HOUR = 3_600_000;
let clock: FakeClock;
let app: FastifyInstance;
let w: HostelWorld;

beforeAll(async () => {
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock, { mediaStorage: new MemoryMediaStorage() });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetAllHavenTables();
  clock.set(NOW);
  w = await hostelWorld();
});

const bearer = async (type: 'user' | 'visitor', id: string) =>
  `Bearer ${await issueToken(clock, { type, id })}`;

function openSession(token: string, location: object | null = goodLocation()) {
  return supertest(app.server)
    .post('/v1/scan-sessions')
    .send({ token, clientNonce: `nonce-${randomUUID()}`, location });
}

describe('E-04: three friends arrive together', () => {
  it('one gate token works for each of them within its 30 s life, each with their own session', async () => {
    const token = generateGateToken({ secret: w.gate.secret, gateCode: w.gate.code, now: NOW });
    const ids: string[] = [];
    for (const offset of [0, 10_000, 25_000]) {
      clock.set(new Date(NOW.getTime() + offset));
      const res = await openSession(token);
      expect(res.status).toBe(201);
      expect(res.body.gpsOk).toBe(true);
      ids.push(res.body.scanSessionId as string);
    }
    expect(new Set(ids).size).toBe(3);
  });
});

describe('E-14: gate location not set', () => {
  it('scans are not location-verified (gate_not_configured) and W-09 shows the gate as not configured', async () => {
    await db
      .updateTable('haven.gates')
      .set({ lat: null, lng: null })
      .where('id', '=', w.gate.gateId)
      .execute();
    const res = await openSession(
      generateGateToken({ secret: w.gate.secret, gateCode: w.gate.code, now: NOW }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ gpsOk: false, gpsFailure: 'gate_not_configured' });

    const gates = await supertest(app.server)
      .get('/v1/admin/gates')
      .set('Authorization', await bearer('user', w.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(gates.status).toBe(200);
    expect(gates.body.items.find((g: { id: string }) => g.id === w.gate.gateId)).toMatchObject({
      configured: false,
    });
  });
});

describe('E-23: two gate devices on one gate', () => {
  it('both are paired to the same gate secret, so a QR from either is valid', async () => {
    const tokenA = await pairDevice(app, clock, w);
    const tokenB = await pairDevice(app, clock, w);
    expect(tokenA).not.toBe(tokenB);
    const devices = await db
      .selectFrom('haven.gate_devices')
      .select(['gate_id', 'revoked_at'])
      .where('gate_id', '=', w.gate.gateId)
      .execute();
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.revoked_at === null)).toBe(true);
    // Tokens derive from the per-gate secret, not the device: the same step from either
    // screen is the same valid token.
    const res = await openSession(
      generateGateToken({ secret: w.gate.secret, gateCode: w.gate.code, now: NOW }),
    );
    expect(res.status).toBe(201);
  });
});

describe("E-24: an approved guest at another hostel's gate", () => {
  it('is offered only Request entry there', async () => {
    const other = await hostelWorld();
    await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'approved',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + HOUR),
    });
    const guest = await bearer('visitor', w.visitorId);
    const scan = await scanAndPhoto(app, clock, { gate: other.gate, bearer: guest.slice(7) });
    const res = await supertest(app.server)
      .get(`/v1/scan-sessions/${scan.sessionId}`)
      .set('Authorization', guest)
      .set('X-Scan-Nonce', scan.nonce);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actions: ['request_entry'], visits: [] });
  });
});

describe('E-20: roommates', () => {
  it('the warden sees the verified residents already in the room a new resident claims', async () => {
    const room = await db
      .selectFrom('haven.residents')
      .innerJoin('haven.rooms', 'haven.rooms.id', 'haven.residents.room_id')
      .select(['haven.rooms.id', 'haven.rooms.number'])
      .where('haven.residents.user_id', '=', w.residentId)
      .executeTakeFirstOrThrow();
    const newcomer = await makeVerifiedHost(db, w.hostelId);
    await db
      .updateTable('haven.residents')
      .set({ status: 'pending', room_id: room.id, claimed_room: room.number })
      .where('user_id', '=', newcomer)
      .execute();
    await db
      .updateTable('haven.residents')
      .set({ submitted_at: NOW.toISOString() })
      .where('user_id', '=', newcomer)
      .execute();

    const res = await supertest(app.server)
      .get('/v1/admin/residents?status=pending')
      .set('Authorization', await bearer('user', w.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(res.status).toBe(200);
    const row = (res.body.items ?? res.body).find(
      (r: { userId: string }) => r.userId === newcomer,
    ) as { roommates: { userId: string }[] };
    expect(row.roommates.map((m) => m.userId)).toEqual([w.residentId]);
  });
});

describe('FR-45: "My guest has left" is flagged to the warden', () => {
  it('the visit closes as host_marked_left and appears under that flag in the warden list', async () => {
    const visitId = await seedVisit({
      hostelId: w.hostelId,
      hostId: w.residentId,
      visitorId: w.visitorId,
      status: 'inside',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + HOUR),
    });
    const left = await supertest(app.server)
      .post(`/v1/visits/${visitId}/mark-left`)
      .set('Authorization', await bearer('user', w.residentId))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(left.status).toBe(200);

    const list = await supertest(app.server)
      .get('/v1/admin/visits?flag=host_marked_left')
      .set('Authorization', await bearer('user', w.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(list.status).toBe(200);
    const items = (list.body.items ?? list.body) as { id: string; status: string }[];
    expect(items.map((v) => v.id)).toEqual([visitId]);
    expect(items[0]?.status).toBe('completed');

    const others = await supertest(app.server)
      .get('/v1/admin/visits?flag=overstay')
      .set('Authorization', await bearer('user', w.wardenId))
      .set('X-Hostel-Id', w.hostelId);
    expect(((others.body.items ?? others.body) as unknown[]).length).toBe(0);
  });
});

describe('TC-FLOW-02: a walk-in approved by the host', () => {
  it('goes inside with the entry time = the approval time, from the consumed scan session', async () => {
    const guest = await bearer('visitor', w.visitorId);
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer: guest.slice(7) });
    const created = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/walk-in`)
      .set('Authorization', guest)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', randomUUID())
      .send({ hostId: w.residentId, type: 'day', durationMinutes: 60, photoId: scan.photoId });
    expect(created.status).toBe(201);
    const visitId = created.body.visit.id as string;

    const approvedAt = new Date(NOW.getTime() + 3 * 60_000);
    clock.set(approvedAt);
    const approve = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Authorization', await bearer('user', w.residentId))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('inside');

    const visit = await db
      .selectFrom('haven.visits')
      .select(['status', 'first_entry_at', 'last_entry_at'])
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(visit).toEqual({
      status: 'inside',
      first_entry_at: approvedAt,
      last_entry_at: approvedAt,
    });

    const session = await db
      .selectFrom('haven.scan_sessions')
      .select(['consumed_at', 'consumed_action', 'visit_id'])
      .where('id', '=', scan.sessionId)
      .executeTakeFirstOrThrow();
    expect(session.consumed_at).not.toBeNull();
    expect(session.consumed_action).toBe('walk_in');
    expect(session.visit_id).toBe(visitId);

    const events = await db
      .selectFrom('haven.gate_events')
      .select(['kind', 'at', 'scan_session_id'])
      .where('visit_id', '=', visitId)
      .execute();
    expect(events).toEqual([{ kind: 'entry', at: approvedAt, scan_session_id: scan.sessionId }]);

    // The session can't be used again.
    const again = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Authorization', guest)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', randomUUID())
      .send({ visitId, photoId: scan.photoId });
    expect(again.status).toBe(410);
  });
});

describe('§9.13: every response carries the server clock', () => {
  it('X-Server-Time is the injected clock, not the machine clock', async () => {
    clock.set(new Date('2026-10-12T07:30:00.000Z'));
    const res = await supertest(app.server).get('/v1/hostels');
    expect(res.headers['x-server-time']).toBe('2026-10-12T07:30:00.000Z');
    const err = await supertest(app.server).get('/v1/me');
    expect(err.status).toBe(401);
    expect(err.headers['x-server-time']).toBe('2026-10-12T07:30:00.000Z');
  });
});
