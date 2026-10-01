import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import { signInWithGoogle, getResidentStatus } from '../src/auth/google-service.js';
import { FakeGoogleIdTokenVerifier } from '../src/auth/google.js';
import { FakeClock } from '../src/lib/clock.js';
import { sha256 } from '../src/lib/crypto.js';

const db = getTestDb();

async function makeHostel(): Promise<string> {
  const row = await db
    .insertInto('haven.hostels')
    .values({
      code: `H${Math.floor(Math.random() * 1_000_000)}`,
      name: 'Test Hostel',
      gender_served: 'male',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeStaffInvite(
  params: {
    email: string;
    hostelId: string | null;
    role: 'super_admin' | 'warden' | 'office';
    token: string;
    expiresInMs?: number;
  },
  clock: FakeClock,
) {
  await db
    .insertInto('haven.staff_invites')
    .values({
      hostel_id: params.hostelId,
      role: params.role,
      email: params.email,
      token_hash: sha256(params.token),
      expires_at: new Date(clock.now().getTime() + (params.expiresInMs ?? 7 * 24 * 60 * 60 * 1000)),
    })
    .execute();
}

describe('Google sign-in (SDD §9.5, §9.6 / F11)', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('valid authentication: a verified Google account creates a new user with no roles', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-1', {
      sub: 'sub-1',
      email: 'resident@haven.test',
      emailVerified: true,
      name: 'Resident One',
    });
    const result = await db
      .transaction()
      .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-1' }));
    expect(result.isNewUser).toBe(true);
    expect(result.roles).toEqual([]);

    const row = await db
      .selectFrom('haven.users')
      .selectAll()
      .where('id', '=', result.userId)
      .executeTakeFirstOrThrow();
    expect(row.email).toBe('resident@haven.test');
    expect(row.google_sub).toBe('sub-1');
  });

  it('invalid credentials: an unverified Google email is rejected (AUTH_REQUIRED)', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-2', {
      sub: 'sub-2',
      email: 'unverified@haven.test',
      emailVerified: false,
      name: 'Nope',
    });
    await expect(
      db
        .transaction()
        .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-2' })),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', httpStatus: 401 });
  });

  it('invalid credentials: a token the verifier does not recognise is rejected', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-3', {
      sub: 's',
      email: 'e@haven.test',
      emailVerified: true,
      name: 'N',
    });
    await expect(
      db
        .transaction()
        .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'wrong-token' })),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('deactivated users: a deactivated existing user cannot sign in again (FORBIDDEN)', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-4', {
      sub: 'sub-4',
      email: 'd@haven.test',
      emailVerified: true,
      name: 'D',
    });
    const first = await db
      .transaction()
      .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-4' }));
    await db
      .updateTable('haven.users')
      .set({ is_active: false })
      .where('id', '=', first.userId)
      .execute();

    await expect(
      db
        .transaction()
        .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-4' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('invited-email matching: signing in with the email a staff invite was sent to accepts it and grants the role', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const hostelId = await makeHostel();
    await makeStaffInvite(
      { email: 'warden@haven.test', hostelId, role: 'warden', token: 'invite-tok' },
      clock,
    );

    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-5', {
      sub: 'sub-5',
      email: 'warden@haven.test',
      emailVerified: true,
      name: 'Warden',
    });
    const result = await db.transaction().execute((trx) =>
      signInWithGoogle(trx, verifier, clock, {
        idToken: 'tok-5',
        staffInviteToken: 'invite-tok',
      }),
    );

    expect(result.roles).toEqual([{ h: hostelId, r: 'warden' }]);

    const invite = await db
      .selectFrom('haven.staff_invites')
      .selectAll()
      .where('email', '=', 'warden@haven.test')
      .executeTakeFirstOrThrow();
    expect(invite.accepted_at).not.toBeNull();
    expect(invite.accepted_by).toBe(result.userId);
  });

  it('wrong invited email: a token addressed to a different email is INVITE_EMAIL_MISMATCH', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const hostelId = await makeHostel();
    await makeStaffInvite(
      { email: 'intended@haven.test', hostelId, role: 'office', token: 'invite-tok-2' },
      clock,
    );

    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-6', {
      sub: 'sub-6',
      email: 'someone-else@haven.test',
      emailVerified: true,
      name: 'Someone Else',
    });
    await expect(
      db.transaction().execute((trx) =>
        signInWithGoogle(trx, verifier, clock, {
          idToken: 'tok-6',
          staffInviteToken: 'invite-tok-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH', httpStatus: 403 });
  });

  it('expired credentials: an expired/unknown invite token is INVITE_EXPIRED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const hostelId = await makeHostel();
    await makeStaffInvite(
      {
        email: 'late@haven.test',
        hostelId,
        role: 'office',
        token: 'invite-tok-3',
        expiresInMs: 1000,
      },
      clock,
    );
    clock.advance(2000);

    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-7', {
      sub: 'sub-7',
      email: 'late@haven.test',
      emailVerified: true,
      name: 'Late',
    });
    await expect(
      db.transaction().execute((trx) =>
        signInWithGoogle(trx, verifier, clock, {
          idToken: 'tok-7',
          staffInviteToken: 'invite-tok-3',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED', httpStatus: 410 });
  });

  it('accepts any pending staff invite for the signed-in email even without a staffInviteToken', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    await makeStaffInvite(
      { email: 'superadmin@haven.test', hostelId: null, role: 'super_admin', token: 'unused-tok' },
      clock,
    );

    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-8', {
      sub: 'sub-8',
      email: 'superadmin@haven.test',
      emailVerified: true,
      name: 'Super Admin',
    });
    const result = await db
      .transaction()
      .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-8' }));
    expect(result.roles).toEqual([]); // super_admin grants carry hostel_id null, excluded from the roles claim by design
    const grant = await db
      .selectFrom('haven.role_assignments')
      .selectAll()
      .where('user_id', '=', result.userId)
      .executeTakeFirstOrThrow();
    expect(grant.role).toBe('super_admin');
    expect(grant.hostel_id).toBeNull();
  });

  it('getResidentStatus returns null for a non-resident user', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00Z'));
    const verifier = FakeGoogleIdTokenVerifier.withOne('tok-9', {
      sub: 'sub-9',
      email: 'notres@haven.test',
      emailVerified: true,
      name: 'X',
    });
    const result = await db
      .transaction()
      .execute((trx) => signInWithGoogle(trx, verifier, clock, { idToken: 'tok-9' }));
    expect(await getResidentStatus(db, result.userId)).toBeNull();
  });
});
