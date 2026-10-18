import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { ALL_HOSTELS, type RoleGrant } from './jwt.js';
import type { Clock } from '../lib/clock.js';
import { isSessionActive } from './sessions.js';

/**
 * Loads a user's current role grants (SDD §9.5's `roles: [{h, r}]` access-token claim)
 * from `haven.role_assignments` — only rows with `revoked_at is null` count (SDD §3.4).
 * A super admin's grant has no hostel (`hostel_id is null`, enforced by a check
 * constraint) and is returned with `h: ALL_HOSTELS`.
 */
export async function loadUserRoles(db: Kysely<Database>, userId: string): Promise<RoleGrant[]> {
  const rows = await db
    .selectFrom('haven.role_assignments')
    .select(['hostel_id', 'role'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  return rows.map((row) => ({ h: row.hostel_id ?? ALL_HOSTELS, r: row.role }));
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
  private readonly entries = new Map<
    string,
    { validUntil: number; isValid: boolean; userId: string | null; roles: RoleGrant[] }
  >();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly ttlMs = 30_000,
  ) {}

  async isValid(sessionId: string, userIdIfAny: string | null): Promise<boolean> {
    return (await this.check(sessionId, userIdIfAny)).isValid;
  }

  /**
   * Session validity plus the user's *current* role grants. Staff authorization uses
   * these, not the access token's `roles` claim, so a revoked role or hostel stops
   * working within the same 30 s bound as a revoked session (SDD §3.4: "Hostel scope
   * comes from role_assignments where revoked_at is null"), and immediately when the
   * change is made through this API (`forgetUser`).
   */
  async check(
    sessionId: string,
    userIdIfAny: string | null,
  ): Promise<{ isValid: boolean; roles: RoleGrant[] }> {
    const now = this.clock.now().getTime();
    const cached = this.entries.get(sessionId);
    if (cached && cached.validUntil > now) {
      return { isValid: cached.isValid, roles: cached.roles };
    }

    const sessionOk = await isSessionActive(this.db, sessionId, this.clock);
    const userOk = sessionOk && userIdIfAny ? await isUserActive(this.db, userIdIfAny) : sessionOk;
    const isValid = sessionOk && userOk;
    const roles = isValid && userIdIfAny ? await loadUserRoles(this.db, userIdIfAny) : [];

    this.entries.set(sessionId, {
      validUntil: now + this.ttlMs,
      isValid,
      userId: userIdIfAny,
      roles,
    });
    return { isValid, roles };
  }

  /**
   * FR-07: "all their sessions end immediately". Drops every cached entry for this
   * user so their next request re-reads the (now revoked) session and roles.
   */
  forgetUser(userId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.userId === userId) this.entries.delete(sessionId);
    }
  }

  /** Test-only: forces the next check to hit the DB again. */
  __clearForTests(): void {
    this.entries.clear();
  }
}
