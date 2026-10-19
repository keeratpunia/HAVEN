import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { FakeClock } from '../src/lib/clock.js';
import { createSession } from '../src/auth/sessions.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { resetAllHavenTables } from './db-test-helper.js';
import {
  buildTestApp,
  db,
  idem,
  issueToken,
  JWT_SECRET,
  MemoryMediaStorage,
  scanAndPhoto,
} from './app-test-helpers.js';
import {
  grant,
  hostelWorld,
  makeUser,
  pairDevice,
  pendingResident,
  seedCharge,
  seedVisit,
  type HostelWorld,
} from './staff-fixtures.js';

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST, Monday
const HOUR = 3_600_000;

let app: FastifyInstance;
let clock: FakeClock;
let storage: MemoryMediaStorage;
let A: HostelWorld;
let B: HostelWorld;
let wardenA: string;
let officeA: string;
let wardenB: string;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  storage = new MemoryMediaStorage();
  app = await buildTestApp(clock, { mediaStorage: storage, streamPingMs: 200 });
  A = await hostelWorld();
  B = await hostelWorld();
  wardenA = `Bearer ${await issueToken(clock, { type: 'user', id: A.wardenId })}`;
  officeA = `Bearer ${await issueToken(clock, { type: 'user', id: A.officeId })}`;
  wardenB = `Bearer ${await issueToken(clock, { type: 'user', id: B.wardenId })}`;
});

afterEach(async () => {
  await app.close();
});

function adminReq(method: 'get' | 'post' | 'put', path: string, auth: string, hostelId: string) {
  return supertest(app.server)
    [method](path)
    .set('Authorization', auth)
    .set('X-Hostel-Id', hostelId);
}

const inside = (w: HostelWorld, extra: Partial<Parameters<typeof seedVisit>[0]> = {}) =>
  seedVisit({
    hostelId: w.hostelId,
    hostId: w.residentId,
    visitorId: w.visitorId,
    status: 'inside',
    windowStart: new Date(NOW.getTime() - HOUR),
    windowEnd: new Date(NOW.getTime() + 2 * HOUR),
    ...extra,
  });

/** Collects SSE events from /v1/stream until `close()`. */
async function stream(auth: string, hostelId: string) {
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let res!: http.IncomingMessage;
  await new Promise<void>((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/v1/stream?hostelId=${hostelId}`,
        headers: { Authorization: auth },
      },
      (r) => {
        res = r;
        let buf = '';
        r.on('data', (chunk) => {
          buf += chunk.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
            const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
            events.push({ event, data: JSON.parse(data) });
          }
        });
        resolve();
      },
    );
    req.on('error', reject);
  });
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return pred();
  };
  return { res, events, until, close: () => res.destroy() };
}

describe('cross-hostel isolation (TC-SEC-04)', () => {
  it('a warden of hostel A naming hostel B in X-Hostel-Id gets 403 FORBIDDEN everywhere', async () => {
    for (const path of [
      '/v1/admin/dashboard',
      '/v1/admin/visits',
      '/v1/admin/residents',
      '/v1/admin/charges',
      '/v1/admin/audit',
      '/v1/admin/gates',
      '/v1/admin/rules',
      '/v1/admin/emergency',
    ]) {
      const res = await adminReq('get', path, wardenA, B.hostelId);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it("hostel B's records are NOT_FOUND to hostel A's warden, even by id", async () => {
    const visitB = await inside(B);
    const chargeB = await seedCharge({ hostelId: B.hostelId, residentId: B.residentId });
    const checks: [string, 'get' | 'post' | 'put', object?][] = [
      [`/v1/admin/visits/${visitB}`, 'get'],
      [`/v1/admin/visits/${visitB}/resolve-dispute`, 'post', {}],
      [`/v1/admin/residents/${B.residentId}/suspend`, 'post', { reason: 'x' }],
      [`/v1/admin/residents/${B.residentId}/mark-left`, 'post'],
      [`/v1/admin/charges/${chargeB}/confirm`, 'post'],
      [
        `/v1/admin/gates/${B.gate.gateId}/location`,
        'put',
        { lat: 1, lng: 1, radiusM: 50, maxAccuracyM: 75 },
      ],
      [`/v1/admin/gates/${B.gate.gateId}/pairing-codes`, 'post'],
    ];
    for (const [path, method, body] of checks) {
      const r = adminReq(method, path, wardenA, A.hostelId);
      const res = body ? await r.send(body) : await r;
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const force = await adminReq(
      'post',
      `/v1/admin/visits/${visitB}/force-checkout`,
      wardenA,
      A.hostelId,
    )
      .set('Idempotency-Key', idem())
      .send({ reason: 'x' });
    expect(force.status).toBe(404);
    // Hostel B is untouched.
    const row = await db
      .selectFrom('haven.visits')
      .select('status')
      .where('id', '=', visitB)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('inside');
  });

  it('lists only the scoped hostel’s data', async () => {
    await inside(A);
    await inside(B);
    const res = await adminReq('get', '/v1/admin/visits', wardenA, A.hostelId);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].hostel.id).toBe(A.hostelId);
    const charges = await adminReq('get', '/v1/admin/charges', officeA, A.hostelId);
    expect(charges.body.items).toEqual([]);
  });

  it('SSE: subscribing to another hostel is refused; events never cross hostels', async () => {
    const refused = await new Promise<number>((resolve) => {
      void (async () => {
        if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = app.server.address() as AddressInfo;
        http.get(
          {
            host: '127.0.0.1',
            port,
            path: `/v1/stream?hostelId=${B.hostelId}`,
            headers: { Authorization: wardenA },
          },
          (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          },
        );
      })();
    });
    expect(refused).toBe(403);

    const s = await stream(wardenA, A.hostelId);
    const visitB = await inside(B);
    await sql`update haven.visits set status = 'completed' where id = ${visitB}`.execute(db);
    const visitA = await inside(A);
    await sql`update haven.visits set status = 'completed' where id = ${visitA}`.execute(db);
    expect(
      await s.until(() => s.events.some((e) => e.event === 'visit' && e.data.id === visitA)),
    ).toBe(true);
    expect(s.events.some((e) => e.data.id === visitB)).toBe(false);
    s.close();
  });
});

describe('TC-SEC-03: office never receives guest phones or photo URLs', () => {
  it('office charge JSON has no phone or photo fields; the warden’s does', async () => {
    const media = await db
      .insertInto('haven.media')
      .values({
        kind: 'visitor_profile',
        bucket: 'visitor-photos',
        path: `${A.visitorId}/p.jpg`,
        sha256: Buffer.from('h'),
        bytes: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('haven.visitors')
      .set({ profile_media_id: media.id })
      .where('id', '=', A.visitorId)
      .execute();
    const visit = await inside(A, { type: 'overnight_room', nights: 2 });
    await seedCharge({ hostelId: A.hostelId, residentId: A.residentId, visitId: visit });

    const office = await adminReq('get', '/v1/admin/charges', officeA, A.hostelId);
    expect(office.status).toBe(200);
    const raw = JSON.stringify(office.body);
    expect(raw).not.toMatch(/phone/i);
    expect(raw).not.toMatch(/photo/i);
    expect(raw).not.toMatch(/"url"/);
    expect(raw).not.toMatch(/\+91/);
    expect(office.body.items[0].visit.guestName).toBe('Test Guest');

    const warden = await adminReq('get', '/v1/admin/charges', wardenA, A.hostelId);
    expect(warden.body.items[0].visit.guestPhone).toMatch(/^\+91/);
    expect(warden.body.items[0].visit.guestPhoto.url).toMatch(/\/v1\/media\//);
  });

  it('office can’t reach visit endpoints that carry photos or phones', async () => {
    const visit = await inside(A);
    for (const path of [
      `/v1/admin/visits/${visit}`,
      '/v1/admin/visits',
      '/v1/admin/emergency',
      '/v1/admin/residents',
    ]) {
      const res = await adminReq('get', path, officeA, A.hostelId);
      expect(res.status, path).toBe(403);
    }
    const res = await supertest(app.server)
      .get(`/v1/visits/${visit}`)
      .set('Authorization', officeA);
    expect(res.status).toBe(404);
  });

  it('office SSE gets pings but no visit or gate events', async () => {
    const s = await stream(officeA, A.hostelId);
    const visit = await inside(A);
    await sql`update haven.visits set status = 'completed' where id = ${visit}`.execute(db);
    expect(await s.until(() => s.events.filter((e) => e.event === 'ping').length >= 2)).toBe(true);
    expect(s.events.some((e) => e.event === 'visit' || e.event === 'gate')).toBe(false);
    s.close();
  });
});

describe('FR-07: mark left and deactivate end every session immediately (TC-SEC-05)', () => {
  async function session(userId: string) {
    const s = await db.transaction().execute((trx) =>
      createSession(
        trx,
        {
          principalType: 'user',
          principalId: userId,
          client: 'native',
          userAgent: null,
          ip: null,
        },
        clock,
      ),
    );
    const access = await signAccessToken(
      { sub: userId, typ: 'user', sid: s.sessionId, roles: [] },
      JWT_SECRET,
    );
    return { auth: `Bearer ${access}`, refresh: s.refreshToken };
  }

  it('a resident marked left is signed out at once, refresh included, and future visits are cancelled', async () => {
    const s1 = await session(A.residentId);
    const s2 = await session(A.residentId);
    expect((await supertest(app.server).get('/v1/me').set('Authorization', s1.auth)).status).toBe(
      200,
    );
    const future = await seedVisit({
      hostelId: A.hostelId,
      hostId: A.residentId,
      status: 'approved',
      windowStart: new Date(NOW.getTime() + 24 * HOUR),
      windowEnd: new Date(NOW.getTime() + 26 * HOUR),
    });

    const res = await adminReq(
      'post',
      `/v1/admin/residents/${A.residentId}/mark-left`,
      wardenA,
      A.hostelId,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('left');

    // No clock advance: "immediately", not "within 30 s".
    for (const s of [s1, s2]) {
      const me = await supertest(app.server).get('/v1/me').set('Authorization', s.auth);
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('SESSION_REVOKED');
      const refresh = await supertest(app.server)
        .post('/v1/auth/refresh')
        .set('X-Client', 'native')
        .send({ refreshToken: s.refresh });
      expect(refresh.status).toBe(401);
    }
    const v = await db
      .selectFrom('haven.visits')
      .select(['status', 'cancel_reason'])
      .where('id', '=', future)
      .executeTakeFirstOrThrow();
    expect(v).toEqual({ status: 'cancelled', cancel_reason: 'host_left' });
  });

  it('a deactivated office user is signed out at once and their open stream closes', async () => {
    const s = await session(A.officeId);
    const live = await stream(s.auth, A.hostelId);
    expect(live.res.statusCode).toBe(200);
    const res = await adminReq(
      'post',
      `/v1/admin/staff/${A.officeId}/deactivate`,
      wardenA,
      A.hostelId,
    );
    expect(res.status).toBe(204);
    const me = await supertest(app.server).get('/v1/me').set('Authorization', s.auth);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    expect(await live.until(() => live.res.complete)).toBe(true);
    const user = await db
      .selectFrom('haven.users')
      .select('is_active')
      .where('id', '=', A.officeId)
      .executeTakeFirstOrThrow();
    expect(user.is_active).toBe(false);
  });

  it('a warden can’t deactivate themselves or a warden', async () => {
    expect(
      (await adminReq('post', `/v1/admin/staff/${A.wardenId}/deactivate`, wardenA, A.hostelId))
        .status,
    ).toBe(403);
    const other = await makeUser('Other Warden');
    await grant(other, 'warden', A.hostelId);
    expect(
      (await adminReq('post', `/v1/admin/staff/${other}/deactivate`, wardenA, A.hostelId)).status,
    ).toBe(404);
  });
});

describe('SSE: dashboard sees a gate check-in without reload (FR-50)', () => {
  it('a guest check-in at the gate arrives on the warden’s stream as a visit event', async () => {
    const visit = await seedVisit({
      hostelId: A.hostelId,
      hostId: A.residentId,
      visitorId: A.visitorId,
      status: 'approved',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + 2 * HOUR),
    });
    const s = await stream(wardenA, A.hostelId);
    const guest = `${await issueToken(clock, { type: 'visitor', id: A.visitorId })}`;
    const scan = await scanAndPhoto(app, clock, { gate: A.gate, bearer: guest });
    const res = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${guest}`)
      .set('X-Scan-Nonce', scan.nonce)
      .send({ visitId: visit, photoId: scan.photoId });
    expect(res.body.result).toBe('inside');
    expect(
      await s.until(() =>
        s.events.some((e) => e.event === 'visit' && e.data.id === visit && e.data.s === 'inside'),
      ),
    ).toBe(true);
    const dash = await adminReq('get', '/v1/admin/dashboard', wardenA, A.hostelId);
    expect(dash.body.counts.inside).toBe(1);
    expect(dash.body.latestEvents[0]).toMatchObject({ visitId: visit, kind: 'entry' });
    s.close();
  });

  it('gate devices: pairing and going offline are pushed as gate events (FR-29)', async () => {
    const s = await stream(wardenA, A.hostelId);
    const token = await pairDevice(app, clock, A);
    await supertest(app.server)
      .post('/v1/gate-devices/heartbeat')
      .set('Authorization', `Device ${token}`)
      .send({ clientTime: NOW.toISOString() });
    expect(
      await s.until(() => s.events.some((e) => e.event === 'gate' && e.data.online === true)),
    ).toBe(true);
    await sql`update haven.gate_devices set last_seen_at = now() - interval '6 minutes' where gate_id = ${A.gate.gateId}`.execute(
      db,
    );
    await sql`select haven.job_gate_offline()`.execute(db);
    expect(
      await s.until(() => s.events.some((e) => e.event === 'gate' && e.data.online === false)),
    ).toBe(true);
    const alert = await db
      .selectFrom('haven.notifications')
      .select(['kind', 'recipient_id'])
      .where('kind', '=', 'N-GATE-OFFLINE')
      .executeTakeFirstOrThrow();
    expect(alert.recipient_id).toBe(A.wardenId);
    s.close();
  });
});

describe('staff actions and their effects', () => {
  it('FR-05: verifying deletes the ID card file and record, creates the room, tells the resident', async () => {
    const r = await pendingResident(A.hostelId, storage);
    const list = await adminReq('get', '/v1/admin/residents?status=pending', wardenA, A.hostelId);
    expect(list.body.items[0]).toMatchObject({ userId: r.userId, room: '305' });
    expect(list.body.items[0].idCardPhoto.url).toMatch(/\/v1\/media\//);

    const res = await adminReq(
      'post',
      `/v1/admin/residents/${r.userId}/verify`,
      wardenA,
      A.hostelId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'verified', idCardPhoto: null });
    expect(storage.objects.has(`resident-docs/${r.cardPath}`)).toBe(false);
    const media = await db
      .selectFrom('haven.media')
      .select('deleted_at')
      .where('id', '=', r.cardMediaId)
      .executeTakeFirstOrThrow();
    expect(media.deleted_at).not.toBeNull();
    const room = await db
      .selectFrom('haven.rooms')
      .select('id')
      .where('hostel_id', '=', A.hostelId)
      .where('number', '=', '305')
      .executeTakeFirst();
    expect(room).toBeDefined();
    const n = await db
      .selectFrom('haven.notifications')
      .select(['title', 'body'])
      .where('kind', '=', 'N-RES-DECIDED')
      .executeTakeFirstOrThrow();
    expect(n).toEqual({ title: "You're verified", body: 'You can now invite guests.' });
    // Deciding twice is refused.
    expect(
      (await adminReq('post', `/v1/admin/residents/${r.userId}/verify`, wardenA, A.hostelId))
        .status,
    ).toBe(409);
  });

  it('FR-05: rejecting needs a reason, deletes the ID card, and sends the reason', async () => {
    const r = await pendingResident(A.hostelId, storage);
    const noReason = await adminReq(
      'post',
      `/v1/admin/residents/${r.userId}/reject`,
      wardenA,
      A.hostelId,
    ).send({});
    expect(noReason.status).toBe(400);
    const res = await adminReq(
      'post',
      `/v1/admin/residents/${r.userId}/reject`,
      wardenA,
      A.hostelId,
    ).send({ reason: 'ID card unreadable' });
    expect(res.body).toMatchObject({ status: 'rejected', rejectionReason: 'ID card unreadable' });
    expect(storage.objects.has(`resident-docs/${r.cardPath}`)).toBe(false);
    const n = await db
      .selectFrom('haven.notifications')
      .select(['title', 'body'])
      .where('kind', '=', 'N-RES-DECIDED')
      .executeTakeFirstOrThrow();
    expect(n).toEqual({ title: 'Verification not approved', body: 'ID card unreadable' });
  });

  it('BR-10: suspending cancels future approved visits (waiving charges) and notifies the host; the guest inside stays', async () => {
    const future = await seedVisit({
      hostelId: A.hostelId,
      hostId: A.residentId,
      status: 'approved',
      type: 'overnight_room',
      nights: 1,
      windowStart: new Date(NOW.getTime() + 48 * HOUR),
      windowEnd: new Date(NOW.getTime() + 72 * HOUR),
    });
    const charge = await seedCharge({
      hostelId: A.hostelId,
      residentId: A.residentId,
      visitId: future,
    });
    const now = await inside(A);
    const res = await adminReq(
      'post',
      `/v1/admin/residents/${A.residentId}/suspend`,
      wardenA,
      A.hostelId,
    ).send({ reason: 'Rule 26.5', until: '2026-10-20T00:00:00.000Z' });
    expect(res.body).toMatchObject({
      status: 'suspended',
      hostingSuspendedUntil: '2026-10-20T00:00:00.000Z',
    });
    const statuses = await db
      .selectFrom('haven.visits')
      .select(['id', 'status'])
      .where('id', 'in', [future, now])
      .execute();
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({
      [future]: 'cancelled',
      [now]: 'inside',
    });
    expect(
      (
        await db
          .selectFrom('haven.charges')
          .select('status')
          .where('id', '=', charge)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('waived');
    const n = await db
      .selectFrom('haven.notifications')
      .select('body')
      .where('kind', '=', 'N-HOST-SUSPENDED')
      .executeTakeFirstOrThrow();
    expect(n.body).toBe('Until Tue, 20 Oct. Your upcoming visits were cancelled.');
    // The suspended host can't create visits (HOST_NOT_VERIFIED/SUSPENDED copy).
    const hostAuth = `Bearer ${await issueToken(clock, { type: 'user', id: A.residentId })}`;
    const create = await supertest(app.server)
      .post('/v1/visits')
      .set('Authorization', hostAuth)
      .send({
        kind: 'invite',
        guest: { name: 'Late Friend', phone: '+919812345678' },
        type: 'day',
        windowStart: new Date(NOW.getTime() + HOUR).toISOString(),
        windowEnd: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
      });
    expect(create.status).toBe(422);
    expect(
      (await adminReq('post', `/v1/admin/residents/${A.residentId}/unsuspend`, wardenA, A.hostelId))
        .body.status,
    ).toBe('verified');
  });

  it('FR-53/FR-54, E-12: force check-out with a reason, then a ban keeps the guest out at the gate', async () => {
    const visit = await inside(A);
    const noReason = await adminReq(
      'post',
      `/v1/admin/visits/${visit}/force-checkout`,
      wardenA,
      A.hostelId,
    )
      .set('Idempotency-Key', idem())
      .send({});
    expect(noReason.status).toBe(400);
    const forced = await adminReq(
      'post',
      `/v1/admin/visits/${visit}/force-checkout`,
      wardenA,
      A.hostelId,
    )
      .set('Idempotency-Key', idem())
      .send({ reason: 'Not the host’s guest' });
    expect(forced.body).toMatchObject({ status: 'completed', closeReason: 'forced' });
    const ban = await adminReq('post', '/v1/admin/bans', wardenA, A.hostelId).send({
      visitorId: A.visitorId,
      allHostels: false,
      reason: 'Unknown guest',
    });
    expect(ban.status).toBe(201);

    // The banned guest's next approved visit is refused at check-in (BR-09).
    const next = await seedVisit({
      hostelId: A.hostelId,
      hostId: A.residentId,
      visitorId: A.visitorId,
      status: 'approved',
      windowStart: new Date(NOW.getTime() - HOUR),
      windowEnd: new Date(NOW.getTime() + HOUR),
    });
    const guest = await issueToken(clock, { type: 'visitor', id: A.visitorId });
    const scan = await scanAndPhoto(app, clock, { gate: A.gate, bearer: guest });
    const checkIn = await supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
      .set('Idempotency-Key', randomUUID())
      .set('Authorization', `Bearer ${guest}`)
      .set('X-Scan-Nonce', scan.nonce)
      .send({ visitId: next, photoId: scan.photoId });
    expect(checkIn.status).toBe(422);
    expect(checkIn.body.error.code).toBe('VISITOR_BANNED');

    const bans = await adminReq('get', '/v1/admin/bans', wardenA, A.hostelId);
    expect(bans.body.items).toHaveLength(1);
    expect(
      (
        await adminReq('post', `/v1/admin/bans/${ban.body.id}/lift`, wardenA, A.hostelId).send({
          reason: 'Resolved',
        })
      ).status,
    ).toBe(204);
  });

  it('FR-55, E-13: a published rules version is what the engine evaluates next', async () => {
    const hostAuth = `Bearer ${await issueToken(clock, { type: 'user', id: A.residentId })}`;
    const preview = () =>
      supertest(app.server)
        .post('/v1/visits/preview')
        .set('Authorization', hostAuth)
        .send({
          kind: 'invite',
          guest: { name: 'Friend', phone: '+919812345678' },
          type: 'day',
          windowStart: new Date(NOW.getTime() + HOUR).toISOString(), // 13:00 IST
          windowEnd: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
        });
    expect((await preview()).body.decision).toBe('allow');
    const bad = await adminReq('post', '/v1/admin/rules', wardenA, A.hostelId).send({
      config: { ...GH8_RULES_CONFIG_V1, visiting_start: 'noon' },
    });
    expect(bad.status).toBe(400);
    const pub = await adminReq('post', '/v1/admin/rules', wardenA, A.hostelId).send({
      config: { ...GH8_RULES_CONFIG_V1, day_visit_latest_end: '14:00' },
    });
    expect(pub.body.version).toBe(2);
    expect((await preview()).body).toMatchObject({ decision: 'deny', codes: ['WINDOW_INVALID'] });
    expect((await adminReq('get', '/v1/admin/rules', wardenA, A.hostelId)).body.version).toBe(2);
    // Hostel B still on version 1.
    expect((await adminReq('get', '/v1/admin/rules', wardenB, B.hostelId)).body.version).toBe(1);
  });

  it('BR-18 and FR-59: fines start at ₹400; office confirms and marks paid; only the warden waives', async () => {
    const low = await adminReq('post', '/v1/admin/charges', wardenA, A.hostelId).send({
      residentId: A.residentId,
      amountInr: 399,
      description: 'Unregistered guest',
    });
    expect(low.status).toBe(400);
    const fine = await adminReq('post', '/v1/admin/charges', wardenA, A.hostelId).send({
      residentId: A.residentId,
      amountInr: 400,
      description: 'Unregistered guest',
    });
    expect(fine.body).toMatchObject({ kind: 'fine', amountInr: 400, status: 'pending' });
    const confirmed = await adminReq(
      'post',
      `/v1/admin/charges/${fine.body.id}/confirm`,
      officeA,
      A.hostelId,
    );
    expect(confirmed.body.status).toBe('confirmed');
    const noReceipt = await adminReq(
      'post',
      `/v1/admin/charges/${fine.body.id}/mark-paid`,
      officeA,
      A.hostelId,
    ).send({});
    expect(noReceipt.status).toBe(400);
    const paid = await adminReq(
      'post',
      `/v1/admin/charges/${fine.body.id}/mark-paid`,
      officeA,
      A.hostelId,
    ).send({ receiptNo: 'GH8-0042' });
    expect(paid.body).toMatchObject({ status: 'paid', receiptNo: 'GH8-0042' });
    expect(
      (
        await adminReq('post', `/v1/admin/charges/${fine.body.id}/waive`, wardenA, A.hostelId).send(
          { reason: 'x' },
        )
      ).status,
    ).toBe(409);
    const notes = await db
      .selectFrom('haven.notifications')
      .select('body')
      .where('kind', '=', 'N-CHARGE')
      .orderBy('created_at')
      .execute();
    expect(notes.map((n) => n.body)).toEqual([
      '₹400 Unregistered guest — pending',
      '₹400 Unregistered guest — paid',
    ]);
  });

  it('W-03 roll call lists everyone inside sorted by room, as JSON and CSV', async () => {
    await inside(A);
    const json = await adminReq('get', '/v1/admin/emergency', wardenA, A.hostelId);
    expect(json.body.count).toBe(1);
    expect(json.body.items[0]).toMatchObject({ guestName: 'Test Guest', hostName: 'Test Host' });
    const csv = await adminReq('get', '/v1/admin/emergency?format=csv', wardenA, A.hostelId);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toBe(
      '"Room","Guest","Host","Zone","Type","Inside since (UTC)"',
    );
  });

  it('W-10: office invites expire in 48 h and are bound to the email (F11)', async () => {
    const res = await adminReq('post', '/v1/admin/staff-invites', wardenA, A.hostelId).send({
      email: 'New.Office@Gmail.test',
      role: 'office',
    });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(/\/staff-invite\/[A-Za-z0-9_-]{32}$/);
    expect(new Date(res.body.expiresAt).getTime() - NOW.getTime()).toBe(48 * HOUR);
    const staff = await adminReq('get', '/v1/admin/staff', wardenA, A.hostelId);
    expect(staff.body.invites[0]).toMatchObject({ email: 'new.office@gmail.test', role: 'office' });
    expect(staff.body.members.map((m: { role: string }) => m.role).sort()).toEqual([
      'office',
      'warden',
    ]);
  });
});

describe('every privileged action writes an audit entry (FR-74, SDD §16.4)', () => {
  it('records the named action, actor and hostel for each', async () => {
    const r1 = await pendingResident(A.hostelId, storage);
    const r2 = await pendingResident(A.hostelId, storage);
    const visit = await inside(A, { disputed: true });
    const visit2 = await inside(A, { visitorId: null });
    const charge = await seedCharge({ hostelId: A.hostelId, residentId: A.residentId });
    const charge2 = await seedCharge({ hostelId: A.hostelId, residentId: A.residentId });
    const other = await makeUser('Leaving Office');
    await grant(other, 'office', A.hostelId);

    const steps: [string, () => Promise<supertest.Response>][] = [
      ['read.visit', () => adminReq('get', `/v1/admin/visits/${visit}`, wardenA, A.hostelId)],
      ['read.emergency', () => adminReq('get', '/v1/admin/emergency', wardenA, A.hostelId)],
      [
        'read.export',
        () =>
          adminReq(
            'get',
            '/v1/admin/reports/visits.csv?from=2026-10-01&to=2026-10-31',
            wardenA,
            A.hostelId,
          ),
      ],
      [
        'admin.visits.resolve_dispute',
        () =>
          adminReq('post', `/v1/admin/visits/${visit}/resolve-dispute`, wardenA, A.hostelId).send({
            note: 'host mistake',
          }),
      ],
      [
        'admin.visits.force_checkout',
        () =>
          adminReq('post', `/v1/admin/visits/${visit2}/force-checkout`, wardenA, A.hostelId)
            .set('Idempotency-Key', idem())
            .send({ reason: 'left unscanned' }),
      ],
      [
        'admin.residents.verify',
        () => adminReq('post', `/v1/admin/residents/${r1.userId}/verify`, wardenA, A.hostelId),
      ],
      ['admin.media.delete_id_card', async () => ({ status: 200 }) as supertest.Response],
      [
        'admin.residents.reject',
        () =>
          adminReq('post', `/v1/admin/residents/${r2.userId}/reject`, wardenA, A.hostelId).send({
            reason: 'blurry',
          }),
      ],
      [
        'admin.bans.create',
        () =>
          adminReq('post', '/v1/admin/bans', wardenA, A.hostelId).send({
            visitorId: A.visitorId,
            allHostels: false,
            reason: 'x',
          }),
      ],
      [
        'admin.residents.suspend',
        () =>
          adminReq('post', `/v1/admin/residents/${A.residentId}/suspend`, wardenA, A.hostelId).send(
            { reason: 'x' },
          ),
      ],
      [
        'admin.residents.unsuspend',
        () =>
          adminReq('post', `/v1/admin/residents/${A.residentId}/unsuspend`, wardenA, A.hostelId),
      ],
      [
        'admin.rules.publish',
        () =>
          adminReq('post', '/v1/admin/rules', wardenA, A.hostelId).send({
            config: GH8_RULES_CONFIG_V1,
          }),
      ],
      [
        'admin.gates.set_location',
        () =>
          adminReq('put', `/v1/admin/gates/${A.gate.gateId}/location`, wardenA, A.hostelId).send({
            lat: 12.97,
            lng: 77.59,
            radiusM: 60,
            maxAccuracyM: 75,
          }),
      ],
      [
        'admin.gates.create_pairing_code',
        () =>
          adminReq('post', `/v1/admin/gates/${A.gate.gateId}/pairing-codes`, wardenA, A.hostelId),
      ],
      [
        'admin.staff.invite_office',
        () =>
          adminReq('post', '/v1/admin/staff-invites', wardenA, A.hostelId).send({
            email: 'x@gmail.test',
            role: 'office',
          }),
      ],
      [
        'admin.staff.deactivate',
        () => adminReq('post', `/v1/admin/staff/${other}/deactivate`, wardenA, A.hostelId),
      ],
      [
        'admin.charges.create_fine',
        () =>
          adminReq('post', '/v1/admin/charges', wardenA, A.hostelId).send({
            residentId: A.residentId,
            amountInr: 500,
            description: 'Late return fine',
          }),
      ],
      [
        'admin.charges.confirm',
        () => adminReq('post', `/v1/admin/charges/${charge}/confirm`, officeA, A.hostelId),
      ],
      [
        'admin.charges.mark_paid',
        () =>
          adminReq('post', `/v1/admin/charges/${charge}/mark-paid`, officeA, A.hostelId).send({
            receiptNo: 'R1',
          }),
      ],
      [
        'admin.charges.waive',
        () =>
          adminReq('post', `/v1/admin/charges/${charge2}/waive`, wardenA, A.hostelId).send({
            reason: 'goodwill',
          }),
      ],
      [
        'admin.residents.mark_left',
        () =>
          adminReq('post', `/v1/admin/residents/${A.residentId}/mark-left`, wardenA, A.hostelId),
      ],
    ];
    for (const [, run] of steps) {
      const res = await run();
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    }
    // A device to revoke.
    await pairDevice(app, clock, A);
    const device = await db
      .selectFrom('haven.gate_devices')
      .select('id')
      .where('gate_id', '=', A.gate.gateId)
      .executeTakeFirstOrThrow();
    expect(
      (await adminReq('post', `/v1/admin/gate-devices/${device.id}/revoke`, wardenA, A.hostelId))
        .status,
    ).toBe(204);

    const rows = await db
      .selectFrom('haven.audit_log')
      .select(['action', 'actor_id', 'hostel_id'])
      .where('action', 'like', '%.%')
      .execute();
    const actions = new Set(rows.filter((r) => r.hostel_id === A.hostelId).map((r) => r.action));
    for (const [action] of steps) expect(actions, action).toContain(action);
    expect(actions).toContain('admin.gates.revoke_device');
    // Actor is the person, never 'system', for these.
    const named = rows.filter((r) => r.action.startsWith('admin.') || r.action.startsWith('read.'));
    expect(named.every((r) => r.actor_id === A.wardenId || r.actor_id === A.officeId)).toBe(true);
    // And the warden can read them back (W-11).
    const audit = await adminReq('get', '/v1/admin/audit?entity=charges', wardenA, A.hostelId);
    expect(
      audit.body.items.some((i: { action: string }) => i.action === 'admin.charges.waive'),
    ).toBe(true);
  });

  it('super admin warden invite and hostel creation are audited too', async () => {
    const superId = await makeUser('Sam Super');
    await grant(superId, 'super_admin', null);
    const su = `Bearer ${await issueToken(clock, { type: 'user', id: superId })}`;
    expect(
      (
        await adminReq('post', '/v1/admin/staff-invites', su, A.hostelId).send({
          email: 'w2@gmail.test',
          role: 'warden',
        })
      ).status,
    ).toBe(201);
    const hostel = await adminReq('post', '/v1/admin/hostels', su, A.hostelId).send({
      code: 'GH-9',
      name: 'Ninth',
      genderServed: 'male',
    });
    expect(hostel.status).toBe(201);
    const rows = await db
      .selectFrom('haven.audit_log')
      .select(['action', 'actor_id'])
      .where('actor_id', '=', superId)
      .execute();
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['admin.staff.invite_warden', 'admin.hostels.create']),
    );
    const gate = await db
      .selectFrom('haven.gates')
      .select(['lat'])
      .where('hostel_id', '=', hostel.body.id)
      .executeTakeFirstOrThrow();
    expect(gate.lat).toBeNull(); // E-14 until the warden sets it
  });
});
