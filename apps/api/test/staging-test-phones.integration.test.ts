import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { DevBypassBotVerifier } from '../src/auth/bot-check.js';
import { TEST_PHONES_ONLY_MESSAGE } from '../src/auth/test-phones.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { buildTestApp, db, issueToken } from './app-test-helpers.js';
import { grant, hostelWorld, makeUser, type HostelWorld } from './staff-fixtures.js';

/**
 * DEC-028: the deployed Phase 1 test version (APP_ENV=staging) must not take in real
 * people. OTP, sign-up / sign-in and guest registration accept only the SDD §9.5 test
 * numbers; residents and staff sign in by test number (no Google in Phase 1); the
 * admin's "set gate location to my position" works there and never in production.
 */

const NOW = new Date('2026-10-12T06:30:00.000Z'); // 12:00 IST
const REAL = '+919812345678';

let staging: FastifyInstance;
let production: FastifyInstance;
let clock: FakeClock;
let w: HostelWorld;

beforeAll(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  const bot = new DevBypassBotVerifier();
  staging = await buildTestApp(clock, { env: { APP_ENV: 'staging' }, botVerifier: bot });
  production = await buildTestApp(clock, { env: { APP_ENV: 'production' }, botVerifier: bot });
  w = await hostelWorld();
});
afterAll(async () => {
  await staging.close();
  await production.close();
});

describe('staging accepts only the test numbers', () => {
  it('refuses an OTP request or verification for a real number, with the test-version message', async () => {
    for (const purpose of ['guest_login', 'phone_verify'] as const) {
      const req = await supertest(staging.server)
        .post('/v1/auth/otp/request')
        .send({ phone: REAL, purpose });
      expect(req.status).toBe(403);
      expect(req.body.error.code).toBe('TEST_PHONES_ONLY');
      expect(req.body.error.message).toBe(TEST_PHONES_ONLY_MESSAGE);
    }
    const verify = await supertest(staging.server)
      .post('/v1/auth/otp/verify')
      .send({ phone: REAL, code: '123456', purpose: 'guest_login' });
    expect(verify.status).toBe(403);
    expect(verify.body.error.message).toBe(TEST_PHONES_ONLY_MESSAGE);
    const stored = await db
      .selectFrom('haven.otp_challenges')
      .select('id')
      .where('phone', '=', REAL)
      .execute();
    expect(stored).toHaveLength(0);
  });

  it('signs a guest in with a test number and 123456', async () => {
    const res = await supertest(staging.server)
      .post('/v1/auth/otp/verify')
      .send({ phone: '9999900001', code: '123456', purpose: 'guest_login' });
    expect(res.status).toBe(200);
    expect(res.body.principal.type).toBe('visitor');
  });

  it('refuses an invite to a real number but takes one to a test number', async () => {
    const host = `Bearer ${await issueToken(clock, { type: 'user', id: w.residentId })}`;
    const invite = (phone: string) =>
      supertest(staging.server)
        .post('/v1/visits')
        .set('Authorization', host)
        .send({
          kind: 'invite',
          guest: { name: 'Simran Kaur', phone, gender: 'female' },
          type: 'day',
          windowStart: NOW.toISOString(),
          windowEnd: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
        });
    const refused = await invite(REAL);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(TEST_PHONES_ONLY_MESSAGE);
    expect((await invite('+919999900002')).status).toBe(201);
  });
});

describe('test sign-in for residents and staff (staging)', () => {
  it('signs in the user who owns a test number, with their roles', async () => {
    await db
      .updateTable('haven.users')
      .set({ phone: '+919999900007', phone_verified_at: NOW.toISOString() })
      .where('id', '=', w.wardenId)
      .execute();
    const res = await supertest(staging.server)
      .post('/v1/auth/test-sign-in')
      .send({ phone: '99999 00007', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.principal.id).toBe(w.wardenId);
    expect(res.body.principal.roles).toEqual([{ h: w.hostelId, r: 'warden' }]);
    expect(res.headers['set-cookie']?.[0]).toMatch(/^haven_rt=/);
  });

  it('creates a new applicant for an unused test number, phone already verified', async () => {
    const res = await supertest(staging.server)
      .post('/v1/auth/test-sign-in')
      .send({ phone: '+919999900003', code: '123456' });
    expect(res.status).toBe(200);
    const user = await db
      .selectFrom('haven.users')
      .select(['id', 'phone', 'phone_verified_at'])
      .where('id', '=', res.body.principal.id)
      .executeTakeFirstOrThrow();
    expect(user.phone).toBe('+919999900003');
    expect(user.phone_verified_at).not.toBeNull();
    expect(res.body.principal.roles).toEqual([]);
  });

  it('refuses a real number and a wrong code', async () => {
    const real = await supertest(staging.server)
      .post('/v1/auth/test-sign-in')
      .send({ phone: REAL, code: '123456' });
    expect(real.status).toBe(403);
    expect(real.body.error.message).toBe(TEST_PHONES_ONLY_MESSAGE);
    const wrong = await supertest(staging.server)
      .post('/v1/auth/test-sign-in')
      .send({ phone: '+919999900003', code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('OTP_INVALID');
  });

  it('does not exist in production', async () => {
    const res = await supertest(production.server)
      .post('/v1/auth/test-sign-in')
      .send({ phone: '+919999900007', code: '123456' });
    expect(res.status).toBe(404);
  });
});

describe('set gate location to my current position (staging only, admin only)', () => {
  const body = { lat: 12.97, lng: 77.59, accuracyM: 12 };

  it('lets the super admin move the gate in staging and keeps the radius', async () => {
    const adminId = await makeUser('Dean');
    await grant(adminId, 'super_admin', null);
    const before = await db
      .selectFrom('haven.gates')
      .select('radius_m')
      .where('id', '=', w.gate.gateId)
      .executeTakeFirstOrThrow();
    const res = await supertest(staging.server)
      .post(`/v1/admin/gates/${w.gate.gateId}/test-location`)
      .set('Authorization', `Bearer ${await issueToken(clock, { type: 'user', id: adminId })}`)
      .set('X-Hostel-Id', w.hostelId)
      .send(body);
    expect(res.status).toBe(200);
    const after = await db
      .selectFrom('haven.gates')
      .select(['lat', 'lng', 'radius_m'])
      .where('id', '=', w.gate.gateId)
      .executeTakeFirstOrThrow();
    expect(Number(after.lat)).toBeCloseTo(12.97);
    expect(Number(after.lng)).toBeCloseTo(77.59);
    expect(after.radius_m).toBe(before.radius_m);

    const inProduction = await supertest(production.server)
      .post(`/v1/admin/gates/${w.gate.gateId}/test-location`)
      .set('Authorization', `Bearer ${await issueToken(clock, { type: 'user', id: adminId })}`)
      .set('X-Hostel-Id', w.hostelId)
      .send(body);
    expect(inProduction.status).toBe(403);
    expect(inProduction.body.error.code).toBe('TEST_ONLY');
  });

  it('refuses the warden (admin only)', async () => {
    const res = await supertest(staging.server)
      .post(`/v1/admin/gates/${w.gate.gateId}/test-location`)
      .set('Authorization', `Bearer ${await issueToken(clock, { type: 'user', id: w.wardenId })}`)
      .set('X-Hostel-Id', w.hostelId)
      .send(body);
    expect(res.status).toBe(403);
  });
});
