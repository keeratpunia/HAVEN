import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { __resetEnvCacheForTests, loadEnv } from '../src/config.js';
import { getTestDb } from './db-test-helper.js';
import type { FakeClock } from '../src/lib/clock.js';
import { FakeGoogleIdTokenVerifier } from '../src/auth/google.js';
import { createLogger } from '../src/lib/logger.js';
import { encryptAesGcm, parseDataEncryptionKey, randomSecret } from '../src/lib/crypto.js';
import { signAccessToken, type RoleGrant } from '../src/auth/jwt.js';
import { createSession } from '../src/auth/sessions.js';
import { generateGateToken } from '../src/gate/token.js';
import { __resetPolicyRegistryForTests } from '../src/auth/policy.js';
import { registerVisitPolicies, __resetVisitPoliciesForTests } from '../src/visits/policy.js';
import { registerGatePolicies, __resetGatePoliciesForTests } from '../src/gate/policy.js';
import { __resetAuthPoliciesForTests } from '../src/auth/policy-rules.js';
import { __resetNotificationPoliciesForTests } from '../src/notify/policy.js';
import { __resetResidentPoliciesForTests } from '../src/residents/routes.js';
import type { MediaStorage } from '../src/gate/media.js';
import type { PushMessage, PushSender, PushTicket, SmsSender } from '../src/notify/senders.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';

/**
 * Shared plumbing for the HTTP-level integration tests: env, app build with every
 * policy registry reset (vitest's isolate:false keeps module state across files — see
 * DEC-010), access tokens, gate tokens, scan sessions, photos.
 */

export const JWT_SECRET = Buffer.alloc(32, 1).toString('base64');
const OTP_PEPPER = Buffer.alloc(32, 2).toString('base64');
const DATA_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString('base64');
const DATA_ENCRYPTION_KEY = parseDataEncryptionKey(DATA_ENCRYPTION_KEY_B64);

export const GATE_LAT = 12.9716;
export const GATE_LNG = 77.5946;
export const API_BASE_URL = 'http://api.haven.test';
export const WEB_BASE_URL = 'https://app.haven.test';

export const db = getTestDb();

export function testEnv(overrides: Record<string, string> = {}) {
  __resetEnvCacheForTests();
  return loadEnv({
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_DIRECT_URL: TEST_DATABASE_URL,
    JWT_SECRET,
    OTP_PEPPER,
    GOOGLE_CLIENT_IDS: 'test-client-id',
    DATA_ENCRYPTION_KEY: DATA_ENCRYPTION_KEY_B64,
    LOG_LEVEL: 'silent',
    API_BASE_URL,
    WEB_BASE_URL,
    ...overrides,
  });
}

/** Keeps uploaded bytes so signed media URLs can be fetched back. */
export class MemoryMediaStorage implements MediaStorage {
  readonly objects = new Map<string, Buffer>();
  async put(path: string, bytes: Buffer): Promise<void> {
    this.objects.set(path, bytes);
  }
  async get(path: string): Promise<Buffer | null> {
    return this.objects.get(path) ?? null;
  }
}

export class FakePushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  /** Per-token override; default ok. */
  readonly responses = new Map<string, PushTicket>();
  fail: Error | null = null;
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.fail) throw this.fail;
    this.sent.push(...messages);
    return messages.map(
      (m, i) => this.responses.get(m.to) ?? { status: 'ok', id: `ticket-${this.sent.length}-${i}` },
    );
  }
}

export class FakeSmsSender implements SmsSender {
  readonly sent: { to: string; templateId: string; body: string }[] = [];
  async send(to: string, templateId: string, body: string): Promise<{ ref: string }> {
    this.sent.push({ to, templateId, body });
    return { ref: `sms-${this.sent.length}` };
  }
}

export async function buildTestApp(
  clock: FakeClock,
  opts: { env?: Record<string, string>; mediaStorage?: MediaStorage } = {},
): Promise<FastifyInstance> {
  __resetPolicyRegistryForTests();
  __resetVisitPoliciesForTests();
  __resetGatePoliciesForTests();
  __resetAuthPoliciesForTests();
  __resetNotificationPoliciesForTests();
  __resetResidentPoliciesForTests();
  registerVisitPolicies();
  registerGatePolicies();
  const env = testEnv(opts.env);
  const app = await buildApp({
    env,
    logger: createLogger(env),
    db,
    clock,
    googleVerifier: new FakeGoogleIdTokenVerifier(new Map()),
    mediaStorage: opts.mediaStorage ?? new MemoryMediaStorage(),
    checkDb: async () => true,
  });
  await app.ready();
  return app;
}

export async function issueToken(
  clock: FakeClock,
  principal: { type: 'visitor' | 'user'; id: string },
  roles: RoleGrant[] = [],
): Promise<string> {
  const session = await db
    .transaction()
    .execute((trx) =>
      createSession(
        trx,
        {
          principalType: principal.type,
          principalId: principal.id,
          client: 'web',
          userAgent: null,
          ip: null,
        },
        clock,
      ),
    );
  return signAccessToken(
    { sub: principal.id, typ: principal.type, sid: session.sessionId, roles },
    JWT_SECRET,
  );
}

export async function makeGateWithSecret(hostelId: string) {
  const secret = randomSecret(32);
  const code = `G${randomUUID().replace(/-/g, '').slice(0, 5).toUpperCase()}`;
  const row = await db
    .insertInto('haven.gates')
    .values({
      hostel_id: hostelId,
      code,
      lat: GATE_LAT,
      lng: GATE_LNG,
      radius_m: 50,
      max_accuracy_m: 75,
      secret_enc: encryptAesGcm(secret, DATA_ENCRYPTION_KEY),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { gateId: row.id, code, secret };
}

let photoSeed = 0;
/** A distinct tiny JPEG each call (PHOTO_REUSED dedupes identical bytes per visitor). */
export async function tinyJpeg(): Promise<Buffer> {
  photoSeed += 1;
  return sharp({
    create: {
      width: 20,
      height: 20,
      channels: 3,
      background: { r: photoSeed % 255, g: (photoSeed * 7) % 255, b: 30 },
    },
  })
    .jpeg()
    .toBuffer();
}

export function goodLocation() {
  return { lat: GATE_LAT, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 };
}

/** A location far outside the geofence (≈ 1.1 km away). */
export function farLocation() {
  return { lat: GATE_LAT + 0.01, lng: GATE_LNG, accuracy: 10, fixAgeMs: 1000 };
}

/** Opens a scan session at `gate`, uploads a live photo, returns ids for the next call. */
export async function scanAndPhoto(
  app: FastifyInstance,
  clock: FakeClock,
  p: {
    gate: { code: string; secret: Buffer };
    bearer: string;
    location?: ReturnType<typeof goodLocation> | null;
  },
): Promise<{ sessionId: string; nonce: string; photoId: string }> {
  const nonce = `nonce-${randomUUID()}`;
  const token = generateGateToken({
    secret: p.gate.secret,
    gateCode: p.gate.code,
    now: clock.now(),
  });
  const created = await supertest(app.server)
    .post('/v1/scan-sessions')
    .send({
      token,
      clientNonce: nonce,
      location: p.location === undefined ? goodLocation() : p.location,
    });
  if (created.status !== 201)
    throw new Error(`scan session failed: ${JSON.stringify(created.body)}`);
  const sessionId = created.body.scanSessionId as string;
  const photo = await supertest(app.server)
    .post(`/v1/scan-sessions/${sessionId}/photo`)
    .set('Authorization', `Bearer ${p.bearer}`)
    .set('X-Scan-Nonce', nonce)
    .attach('photo', await tinyJpeg(), 'photo.jpg');
  if (photo.status !== 200) throw new Error(`photo failed: ${JSON.stringify(photo.body)}`);
  return { sessionId, nonce, photoId: photo.body.photoId as string };
}

export function idem(): string {
  return randomUUID();
}
