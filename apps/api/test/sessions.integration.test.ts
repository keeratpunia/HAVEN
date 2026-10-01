import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import {
  createSession,
  revokeSession,
  rotateRefreshToken,
  isSessionActive,
} from '../src/auth/sessions.js';
import { RevocationCache } from '../src/auth/principal-loader.js';
import { FakeClock } from '../src/lib/clock.js';

const db = getTestDb();

async function makeUser(overrides: Partial<{ isActive: boolean }> = {}): Promise<string> {
  const row = await db
    .insertInto('haven.users')
    .values({
      google_sub: `sub-${Math.random()}`,
      email: `u-${Math.random()}@haven.test`,
      full_name: 'Test User',
      is_active: overrides.isActive ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('sessions / refresh rotation (SDD §9.5)', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('creates a session with a 30-day expiry and a hashed refresh token', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );
    expect(session.refreshToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const row = await db
      .selectFrom('haven.sessions')
      .selectAll()
      .where('id', '=', session.sessionId)
      .executeTakeFirstOrThrow();
    expect(row.expires_at.getTime() - clock.now().getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(row.refresh_hash.length).toBe(32);
  });

  it('rotates the refresh token on use, invalidating the old one', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );

    const rotated = await rotateRefreshToken(db, session.refreshToken, clock);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.principalId).toBe(userId);
  });

  it('revoked sessions: presenting a token from a revoked session is SESSION_REVOKED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );
    await db.transaction().execute((trx) => revokeSession(trx, session.sessionId, 'logout', clock));

    await expect(rotateRefreshToken(db, session.refreshToken, clock)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
      httpStatus: 401,
    });
  });

  it('expired credentials: a refresh token past its expiry is AUTH_REQUIRED, not SESSION_REVOKED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );
    clock.advance(31 * 24 * 60 * 60 * 1000);

    await expect(rotateRefreshToken(db, session.refreshToken, clock)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      httpStatus: 401,
    });
  });

  it('reuse detection: presenting an already-rotated (stale) token revokes the whole session', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );
    const firstRefresh = session.refreshToken;
    const rotated = await rotateRefreshToken(db, firstRefresh, clock);

    // Replaying the stale (already-rotated) token — e.g. a stolen token used after the
    // legitimate client already rotated it — must be treated as compromise.
    await expect(rotateRefreshToken(db, firstRefresh, clock)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });

    // The session is now fully revoked — even the *current* (post-rotation) token no
    // longer works.
    await expect(rotateRefreshToken(db, rotated.refreshToken, clock)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  it('an unrecognised refresh token is AUTH_REQUIRED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    await expect(rotateRefreshToken(db, 'not-a-real-token', clock)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});

describe('RevocationCache (SDD §9.5: "cached 30s")', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('deactivated users: a deactivated user becomes invalid within the cache TTL, not instantly on the DB side', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );

    const cache = new RevocationCache(db, clock);
    expect(await cache.isValid(session.sessionId, userId)).toBe(true);

    await db
      .updateTable('haven.users')
      .set({ is_active: false })
      .where('id', '=', userId)
      .execute();

    // Still cached (within 30s) — the stale cached "valid" answer is the documented
    // trade-off ("deactivation takes effect within 30s", not instantly).
    expect(await cache.isValid(session.sessionId, userId)).toBe(true);

    clock.advance(31_000);
    expect(await cache.isValid(session.sessionId, userId)).toBe(false);
  });

  it('revoked sessions: a revoked session is invalid as soon as the cache re-checks', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const userId = await makeUser();
    const session = await db
      .transaction()
      .execute((trx) =>
        createSession(
          trx,
          { principalType: 'user', principalId: userId, client: 'web', userAgent: null, ip: null },
          clock,
        ),
      );
    const cache = new RevocationCache(db, clock);
    expect(await cache.isValid(session.sessionId, userId)).toBe(true);

    await db.transaction().execute((trx) => revokeSession(trx, session.sessionId, 'logout', clock));
    clock.advance(31_000);
    expect(await cache.isValid(session.sessionId, userId)).toBe(false);
  });

  it('isSessionActive is false for an unknown session id', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    expect(await isSessionActive(db, '00000000-0000-0000-0000-000000000000', clock)).toBe(false);
  });
});
