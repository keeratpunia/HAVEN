import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/index.js';
import type { Clock } from '../lib/clock.js';
import { randomSecret, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { PrincipalType } from '../db/types.js';

/**
 * Session / refresh-token lifecycle (SDD §9.5): refresh token = 32 random bytes
 * base64url, DB keeps only its SHA-256; 30-day TTL; rotated on every use; reuse of an
 * already-rotated token revokes the whole session (the standard refresh-rotation
 * reuse-detection pattern — treats presenting a stale token as a sign of theft).
 */

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface NewSession {
  sessionId: string;
  refreshToken: string;
}

function generateRefreshToken(): { plain: string; hash: Buffer } {
  const bytes = randomSecret(REFRESH_TOKEN_BYTES);
  const plain = bytes.toString('base64url');
  return { plain, hash: sha256(plain) };
}

export async function createSession(
  trx: Transaction<Database>,
  params: {
    principalType: PrincipalType;
    principalId: string;
    client: 'web' | 'native';
    userAgent: string | null;
    ip: string | null;
  },
  clock: Clock,
): Promise<NewSession> {
  const { plain, hash } = generateRefreshToken();
  const now = clock.now();
  const row = await trx
    .insertInto('haven.sessions')
    .values({
      principal_type: params.principalType,
      principal_id: params.principalId,
      refresh_hash: hash,
      client: params.client,
      user_agent: params.userAgent,
      ip: params.ip,
      expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { sessionId: row.id, refreshToken: plain };
}

export interface RotatedSession extends NewSession {
  principalType: PrincipalType;
  principalId: string;
}

/**
 * Rotates a presented refresh token. Throws `AUTH_REQUIRED` (401) if the token is
 * unrecognised or its session has expired/been revoked for an unrelated reason, and
 * `SESSION_REVOKED` (401) if the token was already-rotated (reuse) — in that case the
 * whole session is revoked as a side effect before throwing.
 *
 * Takes a plain `Kysely<Database>`, not a caller-supplied `Transaction`, for the same
 * reason as `verifyOtp`: the reuse-detected revocation write must commit even though
 * this function itself then throws — nesting it inside a transaction the *caller*
 * might wrap around this call would let that throw roll the revocation back too,
 * silently defeating reuse detection.
 */
export async function rotateRefreshToken(
  db: Kysely<Database>,
  presentedToken: string,
  clock: Clock,
): Promise<RotatedSession> {
  const presentedHash = sha256(presentedToken);
  const now = clock.now();

  const current = await db
    .selectFrom('haven.sessions')
    .select(['id', 'principal_type', 'principal_id', 'revoked_at', 'expires_at'])
    .where('refresh_hash', '=', presentedHash)
    .executeTakeFirst();

  if (current) {
    if (current.revoked_at) {
      throw new AppError('SESSION_REVOKED', 401, 'Your session has been signed out.');
    }
    if (current.expires_at.getTime() <= now.getTime()) {
      throw new AppError('AUTH_REQUIRED', 401, 'Your session has expired. Please sign in again.');
    }

    const { plain, hash } = generateRefreshToken();
    await db
      .updateTable('haven.sessions')
      .set({
        refresh_hash: hash,
        previous_refresh_hash: presentedHash,
        last_used_at: now,
        expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      })
      .where('id', '=', current.id)
      .execute();

    return {
      sessionId: current.id,
      refreshToken: plain,
      principalType: current.principal_type,
      principalId: current.principal_id,
    };
  }

  // Not the current token — check whether it's a *previously* rotated token being
  // replayed (reuse), in which case the whole session is compromised.
  const reused = await db
    .selectFrom('haven.sessions')
    .select(['id', 'revoked_at'])
    .where('previous_refresh_hash', '=', presentedHash)
    .executeTakeFirst();

  if (reused && !reused.revoked_at) {
    await db
      .updateTable('haven.sessions')
      .set({ revoked_at: now.toISOString(), revoke_reason: 'refresh_token_reuse' })
      .where('id', '=', reused.id)
      .execute();
    throw new AppError('SESSION_REVOKED', 401, 'Your session has been signed out.');
  }

  throw new AppError('AUTH_REQUIRED', 401, 'Invalid refresh token.');
}

export async function revokeSession(
  trx: Transaction<Database>,
  sessionId: string,
  reason: string,
  clock: Clock,
): Promise<void> {
  await trx
    .updateTable('haven.sessions')
    .set({ revoked_at: clock.now().toISOString(), revoke_reason: reason })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Used by the auth hook's 30s-cached revocation check — a cheap existence probe. */
export async function isSessionActive(
  db: Kysely<Database> | Transaction<Database>,
  sessionId: string,
  clock: Clock,
): Promise<boolean> {
  const row = await db
    .selectFrom('haven.sessions')
    .select(['revoked_at', 'expires_at'])
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!row) return false;
  if (row.revoked_at) return false;
  return row.expires_at.getTime() > clock.now().getTime();
}
