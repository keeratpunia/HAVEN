import type { FastifyInstance } from 'fastify';
import supertest from 'supertest';
import { sql } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from '@haven/shared';
import { FakeClock } from '../src/lib/clock.js';
import { NotificationWorker } from '../src/notify/worker.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { makeHostel, makeVerifiedHost, makeVisitor, makeWarden } from './visits-fixtures.js';
import {
  buildTestApp,
  db,
  farLocation,
  FakePushSender,
  FakeSmsSender,
  idem,
  issueToken,
  makeGateWithSecret,
  scanAndPhoto,
} from './app-test-helpers.js';

// 2026-10-12 16:12 IST (Monday).
const NOW = new Date('2026-10-12T10:42:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let app: FastifyInstance;
let clock: FakeClock;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  app = await buildTestApp(clock);
});

interface World {
  hostelId: string;
  hostId: string;
  hostToken: string;
  wardenId: string;
  gate: { gateId: string; code: string; secret: Buffer };
  visitorId: string;
  visitorToken: string;
}

let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `+9188888${String(10000 + phoneSeq).slice(-5)}`;
}

async function world(): Promise<World> {
  const hostelId = await makeHostel(db);
  // haven.rules_for() (used by the SQL jobs) reads the hostel's rules row (SDD §4.3).
  await sql`insert into haven.hostel_rules (hostel_id, version, config)
            values (${hostelId}, 1, ${JSON.stringify(GH8_RULES_CONFIG_V1)}::jsonb)`.execute(db);
  const hostId = await makeVerifiedHost(db, hostelId);
  await db
    .updateTable('haven.users')
    .set({ phone: nextPhone() })
    .where('id', '=', hostId)
    .execute();
  const wardenId = await makeWarden(db, hostelId);
  await db
    .updateTable('haven.users')
    .set({ phone: nextPhone() })
    .where('id', '=', wardenId)
    .execute();
  const gate = await makeGateWithSecret(hostelId);
  const visitorId = await makeVisitor(db);
  return {
    hostelId,
    hostId,
    hostToken: await issueToken(clock, { type: 'user', id: hostId }),
    wardenId,
    gate,
    visitorId,
    visitorToken: await issueToken(clock, { type: 'visitor', id: visitorId }),
  };
}

async function walkIn(
  w: World,
  opts: { location?: ReturnType<typeof farLocation>; durationMinutes?: number } = {},
) {
  const scan = await scanAndPhoto(app, clock, {
    gate: w.gate,
    bearer: w.visitorToken,
    location: opts.location,
  });
  const res = await supertest(app.server)
    .post(`/v1/scan-sessions/${scan.sessionId}/walk-in`)
    .set('Authorization', `Bearer ${w.visitorToken}`)
    .set('X-Scan-Nonce', scan.nonce)
    .send({
      hostId: w.hostId,
      type: 'day',
      durationMinutes: opts.durationMinutes ?? 60,
      photoId: scan.photoId,
    });
  expect(res.status).toBe(201);
  return res.body.visit.id as string;
}

async function invitedVisit(w: World): Promise<string> {
  const create = await supertest(app.server)
    .post('/v1/visits')
    .set('Authorization', `Bearer ${w.hostToken}`)
    .send({
      kind: 'invite',
      guest: { name: 'Simran Kaur', phone: '+919812345678' },
      type: 'day',
      windowStart: NOW.toISOString(),
      windowEnd: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
    });
  const visitId = create.body.visit.id as string;
  // The guest has claimed it (F1 step 5).
  await db
    .updateTable('haven.visits')
    .set({ visitor_id: w.visitorId })
    .where('id', '=', visitId)
    .execute();
  return visitId;
}

async function guestCheckIn(w: World, visitId: string, location?: ReturnType<typeof farLocation>) {
  const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer: w.visitorToken, location });
  return supertest(app.server)
    .post(`/v1/scan-sessions/${scan.sessionId}/check-in`)
    .set('Authorization', `Bearer ${w.visitorToken}`)
    .set('X-Scan-Nonce', scan.nonce)
    .send({ visitId, photoId: scan.photoId });
}

function hostPost(w: World, path: string, body: object = {}, key = idem()) {
  return supertest(app.server)
    .post(path)
    .set('Authorization', `Bearer ${w.hostToken}`)
    .set('Idempotency-Key', key)
    .send(body);
}

describe('walk-in approvals (FR-40, FR-41, R-08)', () => {
  it('sends N-WALKIN with the catalogue text and a 60 s SMS fallback that opening cancels', async () => {
    const w = await world();
    const visitId = await walkIn(w);

    const rows = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('visit_id', '=', visitId)
      .orderBy('channel')
      .execute();
    const push = rows.find((r) => r.channel === 'push');
    const sms = rows.find((r) => r.channel === 'sms');
    expect(push).toMatchObject({
      kind: 'N-WALKIN',
      title: 'Guest at the gate',
      body: 'Test Guest wants to visit you (Day visit, 1 h). Tap to approve.',
      data: { screen: `/walk-in/${visitId}` },
    });
    expect(sms).toMatchObject({
      sms_template_id: 'HAVEN_WALKIN',
      body: `Test Guest is at the GH-8 gate to visit you. Open HAVEN to approve: https://app.haven.test/walk-in/${visitId}`,
      cancel_if_opened: push?.id,
    });
    expect(sms?.next_attempt_at.getTime()).toBe(NOW.getTime() + MIN);

    // The host taps the push: the fallback SMS is cancelled (SDD §9.7).
    const opened = await supertest(app.server)
      .post(`/v1/notifications/${push?.id}/opened`)
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(opened.status).toBe(204);
    const smsAfter = await db
      .selectFrom('haven.notifications')
      .select('status')
      .where('id', '=', sms?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(smsAfter.status).toBe('cancelled');
  });

  it('approves with an adjusted end time, records the approval, and replays a duplicate key', async () => {
    const w = await world();
    const visitId = await walkIn(w);
    const host = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(host.body.allowedActions).toEqual(['approve', 'reject']);
    expect(host.body.latestPhoto.url).toMatch(
      /^http:\/\/api\.haven\.test\/v1\/media\/[0-9a-f-]+\?exp=\d+&sig=/,
    );
    expect(host.body.guest.profilePhoto).toBeNull();

    const key = idem();
    const windowEnd = new Date(NOW.getTime() + 2 * HOUR).toISOString();
    const first = await hostPost(w, `/v1/visits/${visitId}/approve`, { windowEnd }, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: 'inside',
      windowEnd,
      allowedActions: ['mark_left'],
    });

    const replay = await hostPost(w, `/v1/visits/${visitId}/approve`, { windowEnd }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);

    const entries = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visitId)
      .execute();
    expect(entries).toHaveLength(1);
    const approval = await db
      .selectFrom('haven.approvals')
      .selectAll()
      .where('visit_id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(approval).toMatchObject({
      approver_id: w.hostId,
      approver_role: 'host',
      decision: 'approved',
    });
    expect(approval.adjusted_window_end?.toISOString()).toBe(windowEnd);

    // A second tap with a *new* key is a genuine duplicate action: 409.
    const again = await hostPost(w, `/v1/visits/${visitId}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects a walk-in; the guest page gets the §13.6 "couldn’t approve" moment', async () => {
    const w = await world();
    const visitId = await walkIn(w);
    const res = await hostPost(w, `/v1/visits/${visitId}/reject`, { reason: 'Busy' });
    expect(res.body.status).toBe('rejected');
    const toGuest = await db
      .selectFrom('haven.notifications')
      .select(['recipient_type', 'channel', 'title', 'body'])
      .where('kind', '=', 'N-WALKIN-REJECTED')
      .executeTakeFirstOrThrow();
    expect(toGuest).toEqual({
      recipient_type: 'visitor',
      channel: 'in_app',
      title: "Test couldn't approve this visit",
      body: 'Please contact your host directly.',
    });
  });

  it('expired walk-in (10 min, job) cannot be approved and tells the host by name', async () => {
    const w = await world();
    const visitId = await walkIn(w);
    await db
      .updateTable('haven.visits')
      .set({ created_at: sql`now() - interval '11 minutes'` as unknown as Date })
      .where('id', '=', visitId)
      .execute();
    await sql`select haven.job_expire_walkins()`.execute(db);

    const res = await hostPost(w, `/v1/visits/${visitId}/approve`);
    expect(res.status).toBe(409);
    const expired = await db
      .selectFrom('haven.notifications')
      .select(['title', 'body'])
      .where('kind', '=', 'N-WALKIN-EXPIRED')
      .executeTakeFirstOrThrow();
    expect(expired).toEqual({
      title: 'Guest request expired',
      body: "Test Guest's request at the gate wasn't answered.",
    });
  });

  it('BR-11: approval is refused when the host already has 3 day guests inside', async () => {
    const w = await world();
    const visitId = await walkIn(w);
    for (let i = 0; i < 3; i += 1) {
      await db
        .insertInto('haven.visits')
        .values({
          code: `VAB${String(i).padStart(4, '0').replace(/0/g, 'C')}`.slice(0, 7),
          hostel_id: w.hostelId,
          host_id: w.hostId,
          visitor_id: await makeVisitor(db),
          type: 'day',
          status: 'inside',
          origin: 'walk_in',
          zone: 'room',
          window_start: NOW.toISOString(),
          window_end: new Date(NOW.getTime() + HOUR).toISOString(),
          rules_version: 1,
          created_by_type: 'visitor',
        })
        .execute();
    }
    const res = await hostPost(w, `/v1/visits/${visitId}/approve`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HOST_DAY_LIMIT');
  });

  it('authorization: the guest, another resident and a missing key are all refused', async () => {
    const w = await world();
    const visitId = await walkIn(w);
    const other = await issueToken(clock, {
      type: 'user',
      id: await makeVerifiedHost(db, w.hostelId),
    });

    const byGuest = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Authorization', `Bearer ${w.visitorToken}`)
      .set('Idempotency-Key', idem())
      .send({});
    expect(byGuest.status).toBe(403);
    const byOther = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Authorization', `Bearer ${other}`)
      .set('Idempotency-Key', idem())
      .send({});
    expect(byOther.status).toBe(404);
    const noKey = await supertest(app.server)
      .post(`/v1/visits/${visitId}/approve`)
      .set('Authorization', `Bearer ${w.hostToken}`)
      .send({});
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('F3: a walk-in with unverified location notifies N-CONFIRM-LOCATION; approving confirms it', async () => {
    const w = await world();
    const visitId = await walkIn(w, { location: farLocation() });
    const push = await db
      .selectFrom('haven.notifications')
      .select(['kind', 'title', 'data'])
      .where('visit_id', '=', visitId)
      .where('channel', '=', 'push')
      .executeTakeFirstOrThrow();
    expect(push).toEqual({
      kind: 'N-CONFIRM-LOCATION',
      title: 'Confirm your guest is at the gate',
      data: { screen: `/walk-in/${visitId}` },
    });
    const res = await hostPost(w, `/v1/visits/${visitId}/approve`);
    expect(res.body.flags.locationUnverified).toBe(true);
    expect(res.body.hostConfirmedAt).toBe(NOW.toISOString());
  });
});

describe('arrival confirmation and disputes (FR-42, FR-43, F3, F9, R-09)', () => {
  it('TC-FLOW-04: unverified check-in waits for the host; Confirm performs the entry', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    const checkIn = await guestCheckIn(w, visitId, farLocation());
    expect(checkIn.body.result).toBe('awaiting_host_confirmation');

    const push = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-CONFIRM-LOCATION')
      .where('channel', '=', 'push')
      .executeTakeFirstOrThrow();
    expect(push.body).toBe(
      "Test Guest's location couldn't be checked. Only confirm if you know they're there.",
    );
    expect(push.data).toEqual({ screen: `/arrival/${visitId}` });

    const card = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(card.body).toMatchObject({ status: 'approved', awaitingHostConfirmation: true });
    expect(card.body.allowedActions).toContain('confirm_arrival');
    expect(card.body.latestPhoto).not.toBeNull();

    clock.advance(2 * MIN);
    const confirm = await hostPost(w, `/v1/visits/${visitId}/confirm-arrival`);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ status: 'inside', flags: { locationUnverified: true } });
    expect(confirm.body.hostConfirmedAt).toBe(new Date(NOW.getTime() + 2 * MIN).toISOString());
    // The host just confirmed — no separate N-ARRIVED.
    const arrived = await db
      .selectFrom('haven.notifications')
      .select('id')
      .where('kind', '=', 'N-ARRIVED')
      .execute();
    expect(arrived).toEqual([]);
    const session = await db
      .selectFrom('haven.scan_sessions')
      .select(['consumed_action', 'visit_id'])
      .where('visit_id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(session.consumed_action).toBe('check_in');
  });

  it('a confirmation after the 10-minute scan session is refused as expired', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    await guestCheckIn(w, visitId, farLocation());
    clock.advance(11 * MIN);
    const res = await hostPost(w, `/v1/visits/${visitId}/confirm-arrival`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('SCAN_SESSION_EXPIRED');
  });

  it('N-ARRIVED, then "Yes, that\'s my guest" once; a second confirm is refused', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    expect((await guestCheckIn(w, visitId)).body.result).toBe('inside');
    const arrived = await db
      .selectFrom('haven.notifications')
      .select(['title', 'body', 'data'])
      .where('kind', '=', 'N-ARRIVED')
      .executeTakeFirstOrThrow();
    expect(arrived).toEqual({
      title: 'Test Guest has arrived',
      body: "Checked in at 4:12 pm. Tap if this isn't your guest.",
      data: { screen: `/arrival/${visitId}` },
    });

    const card = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(card.body.allowedActions).toEqual(['confirm_arrival', 'dispute', 'mark_left']);

    expect((await hostPost(w, `/v1/visits/${visitId}/confirm-arrival`)).status).toBe(200);
    const twice = await hostPost(w, `/v1/visits/${visitId}/confirm-arrival`);
    expect(twice.status).toBe(409);
    // Once confirmed, the arrival card's actions are gone.
    expect((await hostPost(w, `/v1/visits/${visitId}/dispute`)).status).toBe(409);
  });

  it('TC-FLOW-06: "Not my guest" flags the visit and alerts wardens by push and SMS immediately', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    await guestCheckIn(w, visitId);
    clock.advance(5 * MIN);

    const res = await hostPost(w, `/v1/visits/${visitId}/dispute`, { note: 'Never seen her' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'inside', flags: { disputed: true } });

    const rows = await db
      .selectFrom('haven.notifications')
      .selectAll()
      .where('kind', '=', 'N-DISPUTE')
      .orderBy('channel')
      .execute();
    expect(rows.map((r) => r.channel)).toEqual(['push', 'sms']);
    expect(rows[0]).toMatchObject({
      recipient_id: w.wardenId,
      title: 'Unknown guest reported',
      data: { screen: `/warden/visits/${visitId}`, note: 'Never seen her' },
    });
    expect(rows[0]?.body).toMatch(
      /^Test Host \(room R\d+\) says Test Guest is not their guest\. Checked in 4:12 pm\.$/,
    );
    expect(rows[1]).toMatchObject({ sms_template_id: 'HAVEN_DISPUTE', cancel_if_opened: null });
    expect(rows[1]?.next_attempt_at.getTime()).toBe(NOW.getTime() + 5 * MIN);

    expect((await hostPost(w, `/v1/visits/${visitId}/dispute`)).status).toBe(409);
  });

  it('the arrival actions expire 30 minutes after entry, and don’t apply to walk-ins', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    await guestCheckIn(w, visitId);
    clock.advance(31 * MIN);
    const late = await hostPost(w, `/v1/visits/${visitId}/dispute`);
    expect(late.status).toBe(409);
    const card = await supertest(app.server)
      .get(`/v1/visits/${visitId}`)
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(card.body.allowedActions).toEqual(['mark_left']);

    const w2 = await world();
    const walk = await walkIn(w2);
    await hostPost(w2, `/v1/visits/${walk}/approve`);
    expect((await hostPost(w2, `/v1/visits/${walk}/dispute`)).status).toBe(409);
  });

  it('"My guest has left" completes the visit (F10); the replay is identical', async () => {
    const w = await world();
    const visitId = await invitedVisit(w);
    await guestCheckIn(w, visitId);
    const key = idem();
    const first = await hostPost(w, `/v1/visits/${visitId}/mark-left`, {}, key);
    expect(first.body.status).toBe('completed');
    const replay = await hostPost(w, `/v1/visits/${visitId}/mark-left`, {}, key);
    expect(replay.body).toEqual(first.body);
    const row = await db
      .selectFrom('haven.visits')
      .select('close_reason')
      .where('id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(row.close_reason).toBe('host_marked_left');
  });
});

describe('host-assisted entry and exit (FR-28, F4)', () => {
  async function assistedEntry(w: World, at?: Date) {
    if (at) clock.set(at);
    const scan = await scanAndPhoto(app, clock, { gate: w.gate, bearer: w.hostToken });
    return supertest(app.server)
      .post(`/v1/scan-sessions/${scan.sessionId}/host-assisted-entry`)
      .set('Authorization', `Bearer ${w.hostToken}`)
      .set('X-Scan-Nonce', scan.nonce)
      .set('Idempotency-Key', idem())
      .send({
        guest: { name: 'Dadi Ji', gender: 'female' },
        type: 'day',
        durationMinutes: 60,
        photoId: scan.photoId,
      });
  }

  it('checks a phone-less guest in with the session’s GPS facts, and out without notifying the host', async () => {
    const w = await world();
    const res = await assistedEntry(w);
    expect(res.status).toBe(201);
    const visitId = res.body.visit.id;
    const entry = await db
      .selectFrom('haven.gate_events')
      .selectAll()
      .where('visit_id', '=', visitId)
      .executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ kind: 'entry', location_verified: true, actor_id: w.hostId });
    expect(entry.distance_m).not.toBeNull();

    const exitScan = await scanAndPhoto(app, clock, { gate: w.gate, bearer: w.hostToken });
    const exit = await supertest(app.server)
      .post(`/v1/scan-sessions/${exitScan.sessionId}/host-assisted-exit`)
      .set('Authorization', `Bearer ${w.hostToken}`)
      .set('X-Scan-Nonce', exitScan.nonce)
      .set('Idempotency-Key', idem())
      .send({ visitId });
    expect(exit.status).toBe(200);
    expect(exit.body.visit.status).toBe('completed');
    const left = await db
      .selectFrom('haven.notifications')
      .select('id')
      .where('kind', '=', 'N-LEFT')
      .execute();
    expect(left).toEqual([]);
  });

  it('runs evaluateEntry: after 20:00 IST a day guest is refused AFTER_ENTRY_CUTOFF', async () => {
    const w = await world();
    const res = await assistedEntry(w, new Date('2026-10-12T14:45:00.000Z')); // 20:15 IST
    expect(res.status).toBe(422);
    // 20:15 + 60 min also breaks the 22:00 window end? No — 21:15; the entry cut-off denies first.
    expect(res.body.error.code).toBe('AFTER_ENTRY_CUTOFF');
  });
});

describe('push registration, in-app list and the worker (SDD §9.7, §12.4, §15)', () => {
  it('registers a token, lists own notifications with their screen, and hides others’', async () => {
    const w = await world();
    const reg = await supertest(app.server)
      .post('/v1/me/push-tokens')
      .set('Authorization', `Bearer ${w.hostToken}`)
      .send({ expoToken: 'ExponentPushToken[host-device]', platform: 'android' });
    expect(reg.status).toBe(204);
    // The same device signing in as another user takes the token with it.
    const other = await makeVerifiedHost(db, w.hostelId);
    const otherToken = await issueToken(clock, { type: 'user', id: other });
    await supertest(app.server)
      .post('/v1/me/push-tokens')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ expoToken: 'ExponentPushToken[host-device]', platform: 'android' })
      .expect(204);
    const tokenRow = await db
      .selectFrom('haven.push_tokens')
      .select('user_id')
      .executeTakeFirstOrThrow();
    expect(tokenRow.user_id).toBe(other);

    const visitId = await walkIn(w);
    const list = await supertest(app.server)
      .get('/v1/me/notifications')
      .set('Authorization', `Bearer ${w.hostToken}`);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        kind: 'N-WALKIN',
        visitId,
        screen: `/walk-in/${visitId}`,
        openedAt: null,
      }),
    ]);
    const othersList = await supertest(app.server)
      .get('/v1/me/notifications')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(othersList.body.items).toEqual([]);
    const notifId = list.body.items[0].id;
    const steal = await supertest(app.server)
      .post(`/v1/notifications/${notifId}/opened`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(steal.status).toBe(404);
    const guest = await supertest(app.server)
      .get('/v1/me/notifications')
      .set('Authorization', `Bearer ${w.visitorToken}`);
    expect(guest.status).toBe(401);
  });

  it('delivers push with the §15.1 payload on the right channel; dead tokens are disabled', async () => {
    const w = await world();
    await db
      .insertInto('haven.push_tokens')
      .values([
        { user_id: w.hostId, expo_token: 'ExponentPushToken[good]', platform: 'android' },
        { user_id: w.hostId, expo_token: 'ExponentPushToken[dead]', platform: 'android' },
      ])
      .execute();
    const push = new FakePushSender();
    push.responses.set('ExponentPushToken[dead]', {
      status: 'error',
      message: 'gone',
      deviceNotRegistered: true,
    });
    const sms = new FakeSmsSender();
    const worker = new NotificationWorker({ db, clock, push, sms });

    const visitId = await walkIn(w);
    expect(await worker.tick()).toBe(1); // the SMS fallback isn't due for 60 s
    expect(push.sent).toHaveLength(2);
    const pushRow = await db
      .selectFrom('haven.notifications')
      .select(['id', 'status'])
      .where('visit_id', '=', visitId)
      .where('channel', '=', 'push')
      .executeTakeFirstOrThrow();
    expect(push.sent[0]).toMatchObject({
      title: 'Guest at the gate',
      channelId: 'approvals',
      priority: 'high',
      data: {
        kind: 'N-WALKIN',
        notificationId: pushRow.id,
        visitId,
        screen: `/walk-in/${visitId}`,
      },
    });
    expect(pushRow.status).toBe('sent');
    const dead = await db
      .selectFrom('haven.push_tokens')
      .select('disabled_at')
      .where('expo_token', '=', 'ExponentPushToken[dead]')
      .executeTakeFirstOrThrow();
    expect(dead.disabled_at).not.toBeNull();

    // Unopened after 60 s: the SMS goes to the host's phone.
    clock.advance(61_000);
    await worker.tick();
    const hostPhone = (
      await db
        .selectFrom('haven.users')
        .select('phone')
        .where('id', '=', w.hostId)
        .executeTakeFirstOrThrow()
    ).phone;
    expect(sms.sent).toEqual([
      {
        to: hostPhone,
        templateId: 'HAVEN_WALKIN',
        vars: ['Test Guest', expect.stringContaining(`/walk-in/${visitId}`)],
        body: expect.stringContaining('Test Guest is at the GH-8 gate'),
      },
    ]);
  });

  it('with no push token the SMS fallback goes out immediately; after approval it is stale', async () => {
    const w = await world();
    const push = new FakePushSender();
    const sms = new FakeSmsSender();
    const worker = new NotificationWorker({ db, clock, push, sms });

    const first = await walkIn(w);
    await worker.tick(); // push → no token → release SMS
    await worker.tick(); // SMS sent now
    expect(push.sent).toEqual([]);
    expect(sms.sent.map((s) => s.templateId)).toEqual(['HAVEN_WALKIN']);
    void first;

    // A second walk-in approved before its SMS is due: the SMS is cancelled as stale.
    const w2 = await world();
    await db
      .insertInto('haven.push_tokens')
      .values({ user_id: w2.hostId, expo_token: 'ExponentPushToken[x]', platform: 'android' })
      .execute();
    const second = await walkIn(w2);
    await worker.tick();
    await hostPost(w2, `/v1/visits/${second}/approve`);
    clock.advance(61_000);
    await worker.tick();
    const smsRow = await db
      .selectFrom('haven.notifications')
      .select(['status', 'last_error'])
      .where('visit_id', '=', second)
      .where('channel', '=', 'sms')
      .executeTakeFirstOrThrow();
    expect(smsRow.status).toBe('cancelled');
    expect(smsRow.last_error).toMatch(/no longer pending_host/);
  });

  it('retries failed sends at 10 s, 30 s, 2 min, 10 min, then gives up', async () => {
    const w = await world();
    await db
      .insertInto('haven.push_tokens')
      .values({ user_id: w.hostId, expo_token: 'ExponentPushToken[y]', platform: 'android' })
      .execute();
    const push = new FakePushSender();
    push.fail = new Error('Expo unavailable');
    const worker = new NotificationWorker({ db, clock, push, sms: new FakeSmsSender() });
    const visitId = await walkIn(w);
    const pushId = (
      await db
        .selectFrom('haven.notifications')
        .select('id')
        .where('visit_id', '=', visitId)
        .where('channel', '=', 'push')
        .executeTakeFirstOrThrow()
    ).id;
    const state = () =>
      db
        .selectFrom('haven.notifications')
        .select(['status', 'attempts', 'next_attempt_at'])
        .where('id', '=', pushId)
        .executeTakeFirstOrThrow();

    for (const delay of [10_000, 30_000, 120_000, 600_000]) {
      await worker.tick();
      const s = await state();
      expect(s.status).toBe('queued');
      expect(s.next_attempt_at.getTime()).toBe(clock.now().getTime() + delay);
      clock.advance(delay);
    }
    // The SMS fallback (due at 60 s) was released and sent along the way; the push gives up.
    await worker.tick();
    expect((await state()).status).toBe('failed');
    expect((await state()).attempts).toBe(5);
  });
});
