import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetAllHavenTables } from './db-test-helper.js';
import { claimInvite } from '../src/auth/invites.js';
import { FakeClock } from '../src/lib/clock.js';
import { sha256 } from '../src/lib/crypto.js';

const db = getTestDb();

async function makeHostelAndResidentHost(): Promise<{ hostelId: string; hostId: string }> {
  const hostel = await db
    .insertInto('haven.hostels')
    .values({
      code: `HI${Math.floor(Math.random() * 1_000_000)}`,
      name: 'Host Hostel',
      gender_served: 'male',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const user = await db
    .insertInto('haven.users')
    .values({
      google_sub: `host-sub-${Math.random()}`,
      email: `host-${Math.random()}@haven.test`,
      full_name: 'Host User',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const room = await db
    .insertInto('haven.rooms')
    .values({ hostel_id: hostel.id, number: 'A1' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('haven.residents')
    .values({
      user_id: user.id,
      hostel_id: hostel.id,
      claimed_room: 'A1',
      room_id: room.id,
      status: 'verified',
    })
    .execute();
  return { hostelId: hostel.id, hostId: user.id };
}

let visitCodeCounter = 0;
// SDD §11.3: `code ~ '^V[0-9A-HJKMNP-TV-Z]{6}$'` — Crockford-style base32, excludes
// I/L/O/U. A plain random/base36 string can land on those and fail the check
// constraint, so generate from this exact alphabet instead.
const VISIT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function nextVisitCode(): string {
  visitCodeCounter += 1;
  let suffix = '';
  let n = visitCodeCounter;
  for (let i = 0; i < 6; i++) {
    suffix = VISIT_CODE_ALPHABET[n % VISIT_CODE_ALPHABET.length] + suffix;
    n = Math.floor(n / VISIT_CODE_ALPHABET.length);
  }
  return `V${suffix}`;
}

async function makeVisit(params: {
  hostelId: string;
  hostId: string;
  invitedPhone: string | null;
  visitorId: string | null;
  token: string | null;
  windowEnd: Date;
}): Promise<string> {
  const row = await db
    .insertInto('haven.visits')
    .values({
      code: nextVisitCode(),
      hostel_id: params.hostelId,
      host_id: params.hostId,
      visitor_id: params.visitorId,
      invited_name: params.visitorId ? null : 'Invited Guest',
      invited_phone: params.invitedPhone,
      type: 'day',
      status: 'pending_host',
      origin: 'invite',
      zone: 'room',
      window_start: new Date(params.windowEnd.getTime() - 60 * 60 * 1000),
      window_end: params.windowEnd,
      invite_token_hash: params.token ? sha256(params.token) : null,
      rules_version: 1,
      created_by_type: 'user',
      created_by_id: params.hostId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeVisitor(phone: string): Promise<string> {
  const row = await db
    .insertInto('haven.visitors')
    .values({ phone, full_name: 'Guest', gender: 'undisclosed' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('invite claim (SDD §9.6)', () => {
  beforeEach(async () => {
    await resetAllHavenTables();
  });

  it('valid authentication: the invited phone claims the invite', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const { hostelId, hostId } = await makeHostelAndResidentHost();
    const visitorId = await makeVisitor('+919876511111');
    const visitId = await makeVisit({
      hostelId,
      hostId,
      invitedPhone: '+919876511111',
      visitorId: null,
      token: 'claim-tok-1',
      windowEnd: new Date(clock.now().getTime() + 60 * 60 * 1000),
    });

    const result = await db
      .transaction()
      .execute((trx) =>
        claimInvite(trx, { token: 'claim-tok-1', visitorId, visitorPhone: '+919876511111' }, clock),
      );
    expect(result.visitId).toBe(visitId);

    const row = await db
      .selectFrom('haven.visits')
      .select('visitor_id')
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(row.visitor_id).toBe(visitorId);
  });

  it('wrong invited phone: a different signed-in phone is INVITE_PHONE_MISMATCH', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const { hostelId, hostId } = await makeHostelAndResidentHost();
    const visitorId = await makeVisitor('+919876522222');
    await makeVisit({
      hostelId,
      hostId,
      invitedPhone: '+919876511111',
      visitorId: null,
      token: 'claim-tok-2',
      windowEnd: new Date(clock.now().getTime() + 60 * 60 * 1000),
    });

    await expect(
      db
        .transaction()
        .execute((trx) =>
          claimInvite(
            trx,
            { token: 'claim-tok-2', visitorId, visitorPhone: '+919876522222' },
            clock,
          ),
        ),
    ).rejects.toMatchObject({ code: 'INVITE_PHONE_MISMATCH', httpStatus: 403 });
  });

  it('already claimed by someone else: INVITE_ALREADY_CLAIMED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const { hostelId, hostId } = await makeHostelAndResidentHost();
    const firstVisitor = await makeVisitor('+919876533333');
    const secondVisitor = await makeVisitor('+919876544444');
    await makeVisit({
      hostelId,
      hostId,
      invitedPhone: '+919876533333',
      visitorId: firstVisitor,
      token: 'claim-tok-3',
      windowEnd: new Date(clock.now().getTime() + 60 * 60 * 1000),
    });

    await expect(
      db
        .transaction()
        .execute((trx) =>
          claimInvite(
            trx,
            { token: 'claim-tok-3', visitorId: secondVisitor, visitorPhone: '+919876544444' },
            clock,
          ),
        ),
    ).rejects.toMatchObject({ code: 'INVITE_ALREADY_CLAIMED', httpStatus: 409 });
  });

  it('re-claiming by the same visitor who already claimed it is idempotent', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const { hostelId, hostId } = await makeHostelAndResidentHost();
    const visitorId = await makeVisitor('+919876555555');
    const visitId = await makeVisit({
      hostelId,
      hostId,
      invitedPhone: '+919876555555',
      visitorId,
      token: 'claim-tok-4',
      windowEnd: new Date(clock.now().getTime() + 60 * 60 * 1000),
    });

    const result = await db
      .transaction()
      .execute((trx) =>
        claimInvite(trx, { token: 'claim-tok-4', visitorId, visitorPhone: '+919876555555' }, clock),
      );
    expect(result.visitId).toBe(visitId);
  });

  it('expired credentials: a visit whose window has already ended is INVITE_EXPIRED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    const { hostelId, hostId } = await makeHostelAndResidentHost();
    const visitorId = await makeVisitor('+919876566666');
    await makeVisit({
      hostelId,
      hostId,
      invitedPhone: '+919876566666',
      visitorId: null,
      token: 'claim-tok-5',
      windowEnd: new Date(clock.now().getTime() - 1000),
    });

    await expect(
      db
        .transaction()
        .execute((trx) =>
          claimInvite(
            trx,
            { token: 'claim-tok-5', visitorId, visitorPhone: '+919876566666' },
            clock,
          ),
        ),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED', httpStatus: 410 });
  });

  it('an unknown token is INVITE_EXPIRED', async () => {
    const clock = new FakeClock(new Date('2026-10-01T10:00:00Z'));
    await expect(
      db.transaction().execute((trx) =>
        claimInvite(
          trx,
          {
            token: 'does-not-exist',
            visitorId: '00000000-0000-0000-0000-000000000000',
            visitorPhone: '+919876500000',
          },
          clock,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVITE_EXPIRED' });
  });
});
