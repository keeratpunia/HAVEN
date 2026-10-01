import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthenticateHook, requireAuth } from './authenticate.js';
import { signAccessToken } from './jwt.js';
import { AppError, toErrorEnvelope } from '../lib/errors.js';

const SECRET = Buffer.alloc(32, 4).toString('base64');

/** A minimal throwaway app exercising only the authenticate hook — not `app.ts`'s real routes. */
function buildTestApp() {
  const app = Fastify();
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      reply.status(err.httpStatus).send(toErrorEnvelope(err, request.id));
      return;
    }
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'test harness error' } });
  });
  app.addHook('onRequest', createAuthenticateHook({ jwtSecretBase64: SECRET }));
  app.get('/public', async (request) => ({ principal: request.principal }));
  app.get('/protected', { preHandler: requireAuth }, async (request) => ({
    principal: request.principal,
  }));
  return app;
}

describe('authenticate hook', () => {
  let app: ReturnType<typeof buildTestApp>;

  afterEach(async () => {
    await app?.close();
  });

  it('decorates request.principal = null when no Authorization header is present', async () => {
    app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/public' });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toBeNull();
  });

  it('decorates a user principal from a valid Bearer token', async () => {
    app = buildTestApp();
    const token = await signAccessToken(
      { sub: 'user-1', typ: 'user', sid: 'sess-1', roles: [{ h: 'hostel-1', r: 'warden' }] },
      SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toEqual({
      type: 'user',
      userId: 'user-1',
      sessionId: 'sess-1',
      roles: [{ h: 'hostel-1', r: 'warden' }],
    });
  });

  it('decorates a visitor principal from a valid Bearer token', async () => {
    app = buildTestApp();
    const token = await signAccessToken(
      { sub: 'visitor-1', typ: 'visitor', sid: 'sess-2', roles: [] },
      SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toEqual({
      type: 'visitor',
      visitorId: 'visitor-1',
      sessionId: 'sess-2',
    });
  });

  it('rejects a malformed Bearer token with 401 AUTH_REQUIRED', async () => {
    app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: 'Bearer garbage' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a token signed with a different secret', async () => {
    app = buildTestApp();
    const token = await signAccessToken(
      { sub: 'user-1', typ: 'user', sid: 'sess-1', roles: [] },
      Buffer.alloc(32, 9).toString('base64'),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('resolves a Device-scheme header to a null principal (device verification is M2 work)', async () => {
    app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: 'Device gd_abc123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toBeNull();
  });

  it('rejects an Authorization header with an unrecognized scheme', async () => {
    app = buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/public',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });

  describe('requireAuth', () => {
    it('blocks an unauthenticated request with 401 AUTH_REQUIRED', async () => {
      app = buildTestApp();
      const res = await app.inject({ method: 'GET', url: '/protected' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('AUTH_REQUIRED');
    });

    it('allows an authenticated request through', async () => {
      app = buildTestApp();
      const token = await signAccessToken(
        { sub: 'user-1', typ: 'user', sid: 'sess-1', roles: [] },
        SECRET,
      );
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('blocks a Device-scheme caller too, since device verification is not implemented yet', async () => {
      app = buildTestApp();
      const res = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { authorization: 'Device gd_abc123' },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
