import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/lib/clock.js';
import { enqueueNotification, type EnqueueParams } from '../src/notify/outbox.js';
import { LEASE_MS, NotificationWorker } from '../src/notify/worker.js';
import { checkPushReceipts, RECEIPT_DELAY_MS } from '../src/notify/receipts.js';
import { personalDataIn } from '../src/notify/sending-rules.js';
import {
  arrivedText,
  chargeText,
  confirmLocationSms,
  confirmLocationText,
  disputeSms,
  disputeText,
  hostSuspendedText,
  leftText,
  overnightDecidedText,
  overnightRequestText,
  residentDecidedText,
  residentSubmittedText,
  SMS_FALLBACK_DELAY_MS,
  walkInExpiredText,
  walkInSms,
  walkInText,
} from '../src/notify/templates.js';
import { resetAllHavenTables } from './db-test-helper.js';
import { db, FakePushSender, FakeSmsSender } from './app-test-helpers.js';
import { makeHostel, makeVerifiedHost } from './visits-fixtures.js';

/**
 * The notification outbox worker (SDD §9.7) and the sending rules (§15.5), against a
 * real Postgres. The worker is driven tick by tick with an injected clock.
 */

const NOW = new Date('2026-10-18T10:30:00.000Z'); // 16:00 IST
const SEC = 1_000;

let clock: FakeClock;
let push: FakePushSender;
let sms: FakeSmsSender;
let hostelId: string;
let hostId: string;

beforeEach(async () => {
  await resetAllHavenTables();
  clock = new FakeClock(NOW);
  push = new FakePushSender();
  sms = new FakeSmsSender();
  hostelId = await makeHostel(db);
  hostId = await makeVerifiedHost(db, hostelId);
  await db
    .updateTable('haven.users')
    .set({ phone: '+919812345678' })
    .where('id', '=', hostId)
    .execute();
});

const worker = (p: FakePushSender = push) => new NotificationWorker({ db, clock, push: p, sms });

async function addToken(token = 'ExponentPushToken[host]') {
  return (
    await db
      .insertInto('haven.push_tokens')
      .values({ user_id: hostId, expo_token: token, platform: 'android' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

async function enqueue(overrides: Partial<EnqueueParams> = {}) {
  return db.transaction().execute((trx) =>
    enqueueNotification(trx, {
      now: clock.now(),
      hostelId,
      recipient: { type: 'user', userId: hostId },
      kind: 'N-ARRIVED',
      channel: 'push',
      text: arrivedText({ guestName: 'Asha', at: NOW }),
      ...overrides,
    }),
  );
}

const row = (id: string) =>
  db
    .selectFrom('haven.notifications')
    .select(['status', 'attempts', 'last_error', 'provider_ref', 'sent_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('delivery (§9.7)', () => {
  it('sends a push once, records the Expo ticket with its token, and marks it sent', async () => {
    const tokenId = await addToken();
    const { id } = await enqueue();
    expect(await worker().tick()).toBe(1);
    expect(await worker().tick()).toBe(0);
    expect(push.sent).toHaveLength(1);
    expect(await row(id ?? '')).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider_ref: `ticket-1-0:${tokenId}`,
    });
  });

  it('a rolled-back transaction sends nothing', async () => {
    await addToken();
    await expect(
      db.transaction().execute(async (trx) => {
        await enqueueNotification(trx, {
          now: clock.now(),
          hostelId,
          recipient: { type: 'user', userId: hostId },
          kind: 'N-WALKIN',
          channel: 'push',
          text: walkInText({ guestName: 'Asha', type: 'day', durationMinutes: 60 }),
          sms: {
            text: walkInSms({ guestName: 'Asha', link: 'https://app.haven.test/walk-in/x' }),
            delayMs: 0,
          },
        });
        throw new Error('the state change failed after enqueueing');
      }),
    ).rejects.toThrow('the state change failed');
    expect(await worker().tick()).toBe(0);
    expect(push.sent).toEqual([]);
    expect(sms.sent).toEqual([]);
    expect(await db.selectFrom('haven.notifications').select('id').execute()).toEqual([]);
  });

  it('a send that keeps failing is retried at 10 s, 30 s, 2 min, 10 min, then marked failed', async () => {
    await addToken();
    const { id } = await enqueue();
    push.fail = new Error('Expo unavailable');
    const w = worker();
    const due = [0, 10_000, 30_000, 120_000, 600_000];
    for (const [i, wait] of due.entries()) {
      clock.advance(wait - SEC);
      if (wait > 0) expect(await w.tick()).toBe(0); // not due a second early
      clock.advance(SEC);
      expect(await w.tick()).toBe(1);
      expect((await row(id ?? '')).attempts).toBe(i + 1);
    }
    expect(await row(id ?? '')).toMatchObject({ status: 'failed', last_error: 'Expo unavailable' });
    clock.advance(3_600_000);
    expect(await w.tick()).toBe(0);
  });

  it('a non-DLT template or text that differs from its template fails at once, without sending', async () => {
    const bad = await db
      .insertInto('haven.notifications')
      .values([
        {
          recipient_type: 'phone',
          recipient_phone: '+919812300001',
          kind: 'N-OVERSTAY-GUEST',
          channel: 'sms',
          body: 'Please leave.',
          sms_template_id: 'HAVEN_MADE_UP',
          data: JSON.stringify({ smsVars: [] }),
          next_attempt_at: NOW,
        },
        {
          recipient_type: 'phone',
          recipient_phone: '+919812300001',
          kind: 'N-OVERSTAY-GUEST',
          channel: 'sms',
          body: 'Your visit ended at 4:30 pm. Please check out at the gate now.',
          sms_template_id: 'HAVEN_OVERSTAY',
          data: JSON.stringify({ smsVars: ['4:30 pm'] }),
          next_attempt_at: NOW,
        },
      ])
      .returning('id')
      .execute();
    await worker().tick();
    expect(sms.sent).toEqual([]);
    const [unknown, drifted] = await Promise.all(bad.map((b) => row(b.id)));
    expect(unknown).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: expect.stringMatching(/not a §15.3 DLT template/),
    });
    expect(drifted).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'SMS text does not match HAVEN_OVERSTAY',
    });
  });
});

describe('concurrency and duplicate processing', () => {
  it('two workers ticking at once never send the same row twice', async () => {
    await addToken();
    for (let i = 0; i < 60; i += 1) await enqueue({ dedupeKey: `arrived:${i}` });
    let release = () => {};
    const p1 = new FakePushSender();
    const p2 = new FakePushSender();
    p1.gate = new Promise((r) => (release = r));
    const a = worker(p1).tick();
    const b = worker(p2).tick();
    const claimedByB = await b; // B finishes while A still holds its batch open
    release();
    const claimedByA = await a;
    expect(claimedByA + claimedByB).toBe(60);
    const ids = [...p1.sent, ...p2.sent].map((m) => m.data.notificationId);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toHaveLength(60);
    const sent = await db
      .selectFrom('haven.notifications')
      .select('status')
      .where('status', '=', 'sent')
      .execute();
    expect(sent).toHaveLength(60);
  });

  it('a row left in "sending" by a dead worker is retried after the lease; the late worker can’t overwrite it', async () => {
    await addToken();
    const { id } = await enqueue();
    let release = () => {};
    const slow = new FakePushSender();
    slow.gate = new Promise((r) => (release = r));
    const dying = worker(slow).tick(); // claims, then hangs mid-send

    await new Promise((r) => setTimeout(r, 50));
    expect((await row(id ?? '')).status).toBe('sending');
    clock.advance(LEASE_MS - SEC);
    expect(await worker().tick()).toBe(0); // still inside the lease
    clock.advance(SEC);
    expect(await worker().tick()).toBe(1); // requeued and sent by a live worker
    const afterRescue = await row(id ?? '');
    expect(afterRescue).toMatchObject({
      status: 'sent',
      attempts: 2,
      provider_ref: expect.stringMatching(/^ticket-1-0:/),
    });

    release();
    await dying; // the stale claim finishes late
    expect(await row(id ?? '')).toEqual(afterRescue);
    expect(push.sent).toHaveLength(1);
  });
});

describe('SMS fallback and opened tracking (§9.7, §15.2)', () => {
  async function walkInWithFallback() {
    await addToken();
    return enqueue({
      kind: 'N-WALKIN',
      text: walkInText({ guestName: 'Asha', type: 'day', durationMinutes: 60 }),
      sms: {
        text: walkInSms({ guestName: 'Asha', link: 'https://app.haven.test/walk-in/v1' }),
        delayMs: SMS_FALLBACK_DELAY_MS,
      },
    });
  }

  it('unopened: no SMS at 59 s, exactly one at 60 s', async () => {
    await walkInWithFallback();
    const w = worker();
    await w.tick();
    clock.advance(59 * SEC);
    await w.tick();
    expect(sms.sent).toEqual([]);
    clock.advance(SEC);
    await w.tick();
    clock.advance(60 * SEC);
    await w.tick();
    expect(sms.sent).toEqual([
      {
        to: '+919812345678',
        templateId: 'HAVEN_WALKIN',
        vars: ['Asha', 'https://app.haven.test/walk-in/v1'],
        body: 'Asha is at the GH-8 gate to visit you. Open HAVEN to approve: https://app.haven.test/walk-in/v1',
      },
    ]);
  });

  it('opened before 60 s: the SMS is cancelled and never sent', async () => {
    const { id, smsId } = await walkInWithFallback();
    const w = worker();
    await w.tick();
    clock.advance(59 * SEC);
    // What POST /notifications/{id}/opened does.
    await db
      .updateTable('haven.notifications')
      .set({ opened_at: clock.now().toISOString() })
      .where('id', '=', id ?? '')
      .execute();
    clock.advance(SEC);
    await w.tick();
    expect(sms.sent).toEqual([]);
    expect(await row(smsId ?? '')).toMatchObject({
      status: 'cancelled',
      last_error: 'push was opened',
    });
  });

  it('no active push token: the SMS fallback goes now; a kind without one stays in-app only', async () => {
    await enqueue({
      kind: 'N-WALKIN',
      text: walkInText({ guestName: 'Asha', type: 'day', durationMinutes: 60 }),
      sms: {
        text: walkInSms({ guestName: 'Asha', link: 'https://app.haven.test/walk-in/v1' }),
        delayMs: SMS_FALLBACK_DELAY_MS,
      },
    });
    const { id: arrived } = await enqueue({ dedupeKey: 'arrived:no-token' });
    const w = worker();
    await w.tick(); // both pushes: no token → walk-in SMS released, N-ARRIVED in-app only
    await w.tick(); // the released SMS
    expect(push.sent).toEqual([]);
    expect(sms.sent.map((s) => s.templateId)).toEqual(['HAVEN_WALKIN']);
    expect(await row(arrived ?? '')).toMatchObject({
      status: 'cancelled',
      last_error: 'no active push token; in-app only',
    });
    const arrivedSms = await db
      .selectFrom('haven.notifications')
      .select('id')
      .where('channel', '=', 'sms')
      .where('kind', '=', 'N-ARRIVED')
      .execute();
    expect(arrivedSms).toEqual([]);
  });
});

describe('§15.5: no guest phone number or photo in a push or SMS body', () => {
  it('every catalogue template, filled with realistic values, is clean', () => {
    const at = NOW;
    const link = 'https://app.haven.test/walk-in/3f2a6c1e-8b7d-4c1a-9e2f-1a2b3c4d5e6f';
    const texts = [
      walkInText({ guestName: 'Asha Rani', type: 'day', durationMinutes: 90 }),
      walkInExpiredText({ guestName: 'Asha Rani' }),
      confirmLocationText({ guestName: 'Asha Rani' }),
      arrivedText({ guestName: 'Asha Rani', at }),
      leftText({ guestName: 'Asha Rani', at, locationVerified: false }),
      disputeText({ hostName: 'Priya S.', room: '214', guestName: 'Asha Rani', checkedInAt: at }),
      overnightRequestText({
        hostName: 'Priya S.',
        room: '214',
        nights: 2,
        guestName: 'Asha Rani',
      }),
      overnightDecidedText({ decision: 'approved', guestName: 'Asha Rani' }),
      residentSubmittedText({ name: 'Neha Verma', room: '214' }),
      residentDecidedText({ decision: 'verified' }),
      hostSuspendedText({ until: at }),
      chargeText({
        amountInr: 100,
        description: 'Overnight room stay, 2 night(s).',
        status: 'pending',
      }),
      walkInSms({ guestName: 'Asha Rani', link }),
      confirmLocationSms({ guestName: 'Asha Rani', link }),
      disputeSms({ hostelCode: 'GH-8', link }),
    ];
    for (const t of texts) {
      expect(personalDataIn('title' in t ? t.title : null)).toBeNull();
      expect(personalDataIn(t.body)).toBeNull();
    }
  });

  it('the guard catches phone numbers in any form and photo links', () => {
    for (const bad of [
      'Call 9876543210',
      'Call +919876543210',
      'Call +91 9876543210',
      'Call 919876543210',
    ]) {
      expect(personalDataIn(bad)).toBe('contains a phone number');
    }
    expect(personalDataIn('See https://api.haven.test/v1/media/abc?sig=x')).toBe(
      'contains a photo link',
    );
    expect(personalDataIn('Checked in at 4:42 pm.')).toBeNull();
    expect(personalDataIn('Visit V7K3Q9A is 30+ minutes past its end time.')).toBeNull();
  });

  it('the worker refuses a push whose text carries a phone number (e.g. typed into a name)', async () => {
    await addToken();
    const { id } = await enqueue({ text: arrivedText({ guestName: 'Asha 9876543210', at: NOW }) });
    await worker().tick();
    expect(push.sent).toEqual([]);
    expect(await row(id ?? '')).toMatchObject({
      status: 'failed',
      last_error: 'blocked by §15.5: contains a phone number',
    });
  });
});

describe('push receipts, 15 minutes later (§9.7)', () => {
  it('fetches receipts once, at 15 min, and disables tokens Expo reports as DeviceNotRegistered', async () => {
    const live = await addToken('ExponentPushToken[live]');
    const dead = await addToken('ExponentPushToken[dead]');
    const { id } = await enqueue();
    await worker().tick();
    expect(push.sent).toHaveLength(2);
    // provider_ref pairs each Expo ticket with the token it went to.
    const pairs = ((await row(id ?? '')).provider_ref ?? '').split(',').map((p) => p.split(':'));
    const deadTicket = pairs.find(([, token]) => token === dead)?.[0] ?? '';
    push.receipts.set(deadTicket, { status: 'error', message: 'gone', deviceNotRegistered: true });

    clock.advance(RECEIPT_DELAY_MS - SEC);
    expect(await checkPushReceipts({ db, push, now: clock.now() })).toEqual({
      checked: 0,
      tokensDisabled: 0,
    });
    clock.advance(SEC);
    expect(await checkPushReceipts({ db, push, now: clock.now() })).toEqual({
      checked: 1,
      tokensDisabled: 1,
    });
    expect(push.receiptRequests.map((r) => [...r].sort())).toEqual([['ticket-2-0', 'ticket-2-1']]);
    const tokens = await db.selectFrom('haven.push_tokens').select(['id', 'disabled_at']).execute();
    expect(Object.fromEntries(tokens.map((t) => [t.id, t.disabled_at !== null]))).toEqual({
      [live]: false,
      [dead]: true,
    });

    clock.advance(60 * SEC);
    expect(await checkPushReceipts({ db, push, now: clock.now() })).toEqual({
      checked: 0,
      tokensDisabled: 0,
    });
  });
});
