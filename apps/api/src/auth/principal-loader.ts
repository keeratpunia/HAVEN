import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { RoleGrant } from './jwt.js';
import type { Clock } from '../lib/clock.js';
import { isSessionActive } from './sessions.js';

/**
 * Loads a user's current role grants (SDD §9.5's `roles: [{h, r}]` access-token claim)
 * from `haven.role_assignments` — only rows with `revoked_at is null` count.
 */
export async function loadUserRoles(db: Kysely<Database>, userId: string): Promise<RoleGrant[]> {
  const rows = await db
    .selectFrom('haven.role_assignments')
    .select(['hostel_id', 'role'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  return rows
    .filter((row): row is { hostel_id: string; role: RoleGrant['r'] } => row.hostel_id !== null)
    .map((row) => ({ h: row.hostel_id, r: row.role }));
}

export async function isUserActive(db: Kysely<Database>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('haven.users')
    .select('is_active')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.is_active ?? false;
}

/**
 * The 30-second-cached revocation/deactivation check (SDD §9.5: "The auth hook rejects
 * tokens whose session is revoked or whose user is inactive — cached 30 s — so
 * deactivation takes effect within 30s"). Checking the DB on literally every request
 * would defeat the point of a short-lived, stateless access token; caching for 30s is
 * the SDD's own stated bound on how stale this check may be.
 *
 * Keyed by session id (one session can only belong to one principal, so this also
 * naturally covers the user-inactive case for `'user'` principals).
 */
export class RevocationCache {
  private readonly entries = new Map<string, { validUntil: number; isValid: boolean }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly ttlMs = 30_000,
  ) {}

  async isValid(sessionId: string, userIdIfAny: string | null): Promise<boolean> {
    const now = this.clock.now().getTime();
    const cached = this.entries.get(sessionId);
    if (cached && cached.validUntil > now) {
      return cached.isValid;
    }

    const sessionOk = await isSessionActive(this.db, sessionId, this.clock);
    const userOk = sessionOk && userIdIfAny ? await isUserActive(this.db, userIdIfAny) : sessionOk;
    const isValid = sessionOk && userOk;

    this.entries.set(sessionId, { validUntil: now + this.ttlMs, isValid });
    return isValid;
  }

  /** Test-only: forces the next check to hit the DB again. */
  __clearForTests(): void {
    this.entries.clear();
  }
}
