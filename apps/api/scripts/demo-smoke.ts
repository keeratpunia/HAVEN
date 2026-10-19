#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * `pnpm demo:smoke` — walks docs/DEMO.md steps A–H against a running `pnpm demo`
 * through the real API (the phone-only parts — camera, GPS — are stood in for by API
 * calls with a generated photo and the gate's own coordinates). Prints one line per
 * step and exits non-zero on the first thing that would break the live demo.
 *
 * It adds visits, guests and charges to the demo database, so restart `pnpm demo`
 * (or `pnpm demo:reset`) before presenting. Demo-only: it talks to 127.0.0.1:8080.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CONSENT_VERSION } from '@haven/shared';
import { generateGateToken } from '../src/gate/token.js';
import {
  DEMO_API_PORT,
  DEMO_GATE_CODE,
  DEMO_GATE_SECRET,
  DEMO_OFFICE_EMAIL,
  DEMO_RESIDENT_1_EMAIL,
  DEMO_WARDEN_EMAIL,
} from './demo-constants.js';

const API = `http://127.0.0.1:${DEMO_API_PORT}`;
const API_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OTP = '123456';
// Not the presenter's +91 9999900001/02: the smoke test signs in its own guests.
const GUEST_A = '+919999900003';
const GUEST_B = '+919999900004';
const GUEST_C = '+919999900005';

let step = 0;
function ok(msg: string) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}
class SmokeFailure extends Error {}
function fail(msg: string, detail?: unknown): never {
  throw new SmokeFailure(`${msg}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`);
}

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a CLI check
}
async function call(
  method: string,
  url: string,
  opts: { auth?: string; body?: unknown; headers?: Record<string, string>; form?: FormData } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API}${url}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: res.status, body: parsed };
}
/** Success means any 2xx here: the exact codes are the API tests' job. */
function expectStatus(res: Res, _status: number, what: string) {
  if (res.status < 200 || res.status > 299) fail(`${what}: got ${res.status}`, res.body);
}

let shade = 0;
async function photo(): Promise<Blob> {
  shade = (shade + 37) % 255;
  const buf = await sharp({
    create: {
      width: 240,
      height: 240,
      channels: 3,
      background: { r: shade, g: 120, b: 255 - shade },
    },
  })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

async function staff(email: string) {
  const res = await call('POST', '/v1/auth/dev-login', { body: { email } });
  expectStatus(res, 200, `dev sign-in ${email}`);
  return res.body.accessToken as string;
}

async function guest(phone: string, name: string): Promise<string> {
  let req = await call('POST', '/v1/auth/otp/request', { body: { phone, purpose: 'guest_login' } });
  const wait = Number(req.body?.error?.details?.retryAfterS ?? 0);
  if (req.status === 429 && wait > 0 && wait <= 120) {
    // The 30 s resend cooldown from an earlier run of this script.
    await new Promise((r) => setTimeout(r, wait * 1000 + 500));
    req = await call('POST', '/v1/auth/otp/request', { body: { phone, purpose: 'guest_login' } });
  }
  expectStatus(req, 202, `OTP request ${phone}`);
  const v = await call('POST', '/v1/auth/otp/verify', {
    body: { phone, code: OTP, purpose: 'guest_login' },
  });
  expectStatus(v, 200, `OTP verify ${phone}`);
  const token = v.body.accessToken as string;
  // G-04 / G-05 (FR-02): name, gender, consent + 18+, live profile photo.
  expectStatus(
    await call('PATCH', '/v1/me', { auth: token, body: { fullName: name, gender: 'female' } }),
    204,
    'profile name',
  );
  expectStatus(
    await call('POST', '/v1/me/consent', {
      auth: token,
      body: { version: CONSENT_VERSION, isAdult: true },
    }),
    204,
    'consent',
  );
  const form = new FormData();
  form.append('photo', await photo(), 'selfie.jpg');
  expectStatus(
    await call('POST', '/v1/me/profile-photo', { auth: token, form }),
    200,
    'profile photo',
  );
  return token;
}

interface Gate {
  id: string;
  lat: number;
  lng: number;
}
async function scan(token: string, gate: Gate, opts: { far?: boolean; tokenAgeMs?: number } = {}) {
  // The gate screen draws its QR from the server's (demo) time, read fresh per scan.
  const now = new Date((await call('GET', '/__demo/clock')).body.now as string);
  const gateToken = generateGateToken({
    secret: DEMO_GATE_SECRET,
    gateCode: DEMO_GATE_CODE,
    now: new Date(now.getTime() - (opts.tokenAgeMs ?? 0)),
  });
  const nonce = `smoke-${randomUUID()}`;
  const created = await call('POST', '/v1/scan-sessions', {
    auth: token,
    body: {
      token: gateToken,
      clientNonce: nonce,
      location: {
        lat: gate.lat + (opts.far ? 0.05 : 0),
        lng: gate.lng,
        accuracy: 12,
        fixAgeMs: 1_000,
      },
    },
  });
  return { created, nonce };
}

async function sessionPhoto(token: string, sessionId: string, nonce: string) {
  const form = new FormData();
  form.append('photo', await photo(), 'photo.jpg');
  const res = await call('POST', `/v1/scan-sessions/${sessionId}/photo`, {
    auth: token,
    headers: { 'x-scan-nonce': nonce },
    form,
  });
  expectStatus(res, 200, 'live photo upload');
  return res.body.photoId as string;
}

async function notificationKinds(token: string): Promise<string[]> {
  const res = await call('GET', '/v1/me/notifications', { auth: token });
  expectStatus(res, 200, 'notifications');
  const items = (res.body.items ?? res.body) as { kind: string }[];
  return items.map((n) => n.kind);
}

async function demoClock(at: string) {
  const res = await call('POST', '/__demo/clock', { body: { at } });
  expectStatus(res, 200, `demo clock ${at}`);
  return new Date(res.body.now as string);
}

function demoJob(...args: string[]) {
  const r = spawnSync('pnpm', ['run', 'demo:job', '--', ...args], {
    cwd: API_DIR,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) fail(`pnpm demo:job ${args.join(' ')} failed`, r.stderr || r.stdout);
  return r.stdout;
}

async function main() {
  console.log(`HAVEN demo smoke test against ${API}\n`);
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) fail('The demo API is not running on :8080. Start `pnpm demo` first.');
  let now = await demoClock('12:00'); // midday IST: every visiting rule allows the happy path
  ok('demo API up; demo clock set to 12:00 IST');

  // ---- A. gate display paired on the laptop ----
  const warden = await staff(DEMO_WARDEN_EMAIL);
  const me = await call('GET', '/v1/me', { auth: warden });
  const hostelId = (me.body.roles as { h: string; r: string }[]).find((r) => r.r === 'warden')?.h;
  if (!hostelId) fail('warden has no hostel', me.body);
  const adminHeaders = { 'x-hostel-id': hostelId };
  const gates = await call('GET', '/v1/admin/gates', { auth: warden, headers: adminHeaders });
  expectStatus(gates, 200, 'W-09 gates');
  const gate = (gates.body.items as Gate[] & { code: string }[]).find(
    (g) => (g as unknown as { code: string }).code === DEMO_GATE_CODE,
  ) as Gate | undefined;
  if (!gate || gate.lat === null) fail('demo gate missing or without a location', gates.body);
  const code = await call('POST', `/v1/admin/gates/${gate.id}/pairing-codes`, {
    auth: warden,
    headers: adminHeaders,
    body: {},
  });
  expectStatus(code, 200, 'pairing code');
  const paired = await call('POST', '/v1/gate-devices/pair', {
    body: { code: String(code.body.code).replace(/[^0-9A-Z]/gi, '') },
  });
  expectStatus(paired, 200, 'pair gate screen');
  ok('A. warden mints a pairing code; the gate screen pairs (D-01 → D-02)');

  // ---- B. invite → guest OTP → profile with consent + live selfie ----
  const priya = await staff(DEMO_RESIDENT_1_EMAIL);
  const invite = await call('POST', '/v1/visits', {
    auth: priya,
    body: {
      kind: 'invite',
      guest: { name: 'Ananya Rao', phone: GUEST_A, gender: 'female' },
      type: 'day',
      windowStart: now.toISOString(),
      windowEnd: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
    },
  });
  expectStatus(invite, 201, 'create invite');
  const inviteToken = String(invite.body.inviteUrl).split('/i/')[1];
  if (!inviteToken) fail('no invite link', invite.body);
  const guestA = await guest(GUEST_A, 'Ananya Rao');
  const claim = await call('POST', `/v1/invites/${inviteToken}/claim`, { auth: guestA, body: {} });
  expectStatus(claim, 200, 'claim invite');
  ok('B. Priya invites Ananya; OTP, consent, live selfie; invite claimed');

  // ---- C. scan → GPS → live photo → checked in; host told ----
  let s = await scan(guestA, gate);
  expectStatus(s.created, 201, 'scan session');
  if (!s.created.body.gpsOk) fail('GPS check failed at the gate location', s.created.body);
  const sid = s.created.body.scanSessionId as string;
  const actions = await call('GET', `/v1/scan-sessions/${sid}`, {
    auth: guestA,
    headers: { 'x-scan-nonce': s.nonce },
  });
  if (actions.body.actions?.[0] !== 'check_in') fail('gate did not offer Check in', actions.body);
  const visitA = actions.body.visits[0] as { id: string; code: string };
  const checkIn = await call('POST', `/v1/scan-sessions/${sid}/check-in`, {
    auth: guestA,
    headers: { 'x-scan-nonce': s.nonce, 'idempotency-key': randomUUID() },
    body: { visitId: visitA.id, photoId: await sessionPhoto(guestA, sid, s.nonce) },
  });
  expectStatus(checkIn, 200, 'check in');
  if (checkIn.body.result !== 'inside') fail('not inside after check-in', checkIn.body);
  const arrived = await notificationKinds(priya);
  if (!arrived.includes('N-ARRIVED')) fail('Priya got no N-ARRIVED', arrived);
  ok(`C. Ananya checks in (${visitA.code}); Priya gets the arrival confirmation`);

  // ---- D. walk-in → host approves → guest turns green ----
  const guestB = await guest(GUEST_B, 'Kavya Nair');
  s = await scan(guestB, gate);
  expectStatus(s.created, 201, 'scan session (walk-in)');
  const sidB = s.created.body.scanSessionId as string;
  const actB = await call('GET', `/v1/scan-sessions/${sidB}`, {
    auth: guestB,
    headers: { 'x-scan-nonce': s.nonce },
  });
  if (actB.body.actions?.[0] !== 'request_entry')
    fail('gate did not offer Request entry', actB.body);
  const rooms = await call('GET', `/v1/hostels/${hostelId}/rooms/101/residents`, {
    auth: guestB,
    headers: { 'x-scan-session': sidB, 'x-scan-nonce': s.nonce },
  });
  expectStatus(rooms, 200, 'G-08 find your host');
  const host = (rooms.body as { residentId: string; displayName: string }[])[0];
  if (!host) fail('no resident in room 101', rooms.body);
  const walkIn = await call('POST', `/v1/scan-sessions/${sidB}/walk-in`, {
    auth: guestB,
    headers: { 'x-scan-nonce': s.nonce, 'idempotency-key': randomUUID() },
    body: {
      hostId: host.residentId,
      type: 'day',
      durationMinutes: 120,
      photoId: await sessionPhoto(guestB, sidB, s.nonce),
    },
  });
  expectStatus(walkIn, 201, 'walk-in request');
  const visitB = walkIn.body.visit as { id: string; code: string };
  if (!(await notificationKinds(priya)).includes('N-WALKIN')) fail('Priya got no N-WALKIN');
  const r08 = await call('GET', `/v1/visits/${visitB.id}`, { auth: priya });
  expectStatus(r08, 200, 'R-08 walk-in request');
  const approve = await call('POST', `/v1/visits/${visitB.id}/approve`, {
    auth: priya,
    headers: { 'idempotency-key': randomUUID() },
    body: {},
  });
  expectStatus(approve, 200, 'approve walk-in');
  const polled = await call('GET', `/v1/visits/${visitB.id}`, { auth: guestB });
  if (polled.body.status !== 'inside') fail('guest screen would not turn green', polled.body);
  ok(`D. Kavya walks in (${visitB.code}); Priya approves; the guest is inside`);

  // ---- E. warden live dashboard, timeline, overnight → office marks paid ----
  const dash = await call('GET', '/v1/admin/dashboard', { auth: warden, headers: adminHeaders });
  expectStatus(dash, 200, 'W-01 dashboard');
  const timeline = await call('GET', `/v1/admin/visits/${visitB.id}`, {
    auth: warden,
    headers: adminHeaders,
  });
  expectStatus(timeline, 200, 'W-05 visit timeline');
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  const dayAfter = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  const overnight = await call('POST', '/v1/visits', {
    auth: priya,
    body: {
      kind: 'overnight',
      guest: { name: 'Ananya Rao', phone: GUEST_A, gender: 'female' },
      type: 'guest_room',
      arrivalDate: tomorrow,
      departureDate: dayAfter,
    },
  });
  expectStatus(overnight, 201, 'R-11 overnight request');
  const ovId = overnight.body.visit.id as string;
  expectStatus(
    await call('POST', `/v1/visits/${ovId}/approve`, {
      auth: warden,
      headers: { 'idempotency-key': randomUUID(), 'x-hostel-id': hostelId },
      body: {},
    }),
    200,
    'warden approves overnight',
  );
  const office = await staff(DEMO_OFFICE_EMAIL);
  const charges = await call('GET', '/v1/admin/charges', { auth: office, headers: adminHeaders });
  expectStatus(charges, 200, 'O-01 charges');
  const charge = (
    charges.body.items as { id: string; status: string; visit: { id: string } | null }[]
  ).find((c) => c.visit?.id === ovId);
  if (!charge) fail('no charge for the approved overnight visit', charges.body);
  if (charge.status === 'pending') {
    expectStatus(
      await call('POST', `/v1/admin/charges/${charge.id}/confirm`, {
        auth: office,
        headers: adminHeaders,
        body: {},
      }),
      200,
      'office confirms charge',
    );
  }
  const paid = await call('POST', `/v1/admin/charges/${charge.id}/mark-paid`, {
    auth: office,
    headers: adminHeaders,
    body: { receiptNo: 'DEMO-0001' },
  });
  expectStatus(paid, 200, 'office marks paid');
  ok('E. dashboard + timeline load; overnight approved; office marks the ₹150 charge paid');

  // ---- F. rules in action ----
  const guestC = await guest(GUEST_C, 'Late Visitor');
  await demoClock('20:05');
  s = await scan(guestC, gate);
  expectStatus(s.created, 201, 'scan after 20:00');
  const sidC = s.created.body.scanSessionId as string;
  const refused = await call('POST', `/v1/scan-sessions/${sidC}/walk-in`, {
    auth: guestC,
    headers: { 'x-scan-nonce': s.nonce, 'idempotency-key': randomUUID() },
    body: {
      hostId: host.residentId,
      type: 'day',
      durationMinutes: 60,
      photoId: await sessionPhoto(guestC, sidC, s.nonce),
    },
  });
  if (refused.status !== 422 || refused.body.error?.code !== 'AFTER_ENTRY_CUTOFF')
    fail('walk-in at 20:05 was not refused with AFTER_ENTRY_CUTOFF', refused.body);
  now = await demoClock('12:30');
  const stale = await scan(guestC, gate, { tokenAgeMs: 60_000 });
  if (stale.created.body?.error?.code !== 'GATE_TOKEN_EXPIRED')
    fail('a 60 s old QR was not refused', stale.created.body);
  const far = await scan(guestC, gate, { far: true });
  if (far.created.body?.gpsOk !== false)
    fail('a scan 5 km away passed the geofence', far.created.body);
  ok('F. 20:05 walk-in refused; old QR refused; far-away scan → location problem');

  // ---- G. jobs: overstay → host → warden escalation; night sweep ----
  demoJob('overstay', visitA.code);
  if (!(await notificationKinds(priya)).includes('N-OVERSTAY-HOST'))
    fail('no N-OVERSTAY-HOST for Priya');
  demoJob('escalate', visitA.code);
  if (!(await notificationKinds(warden)).includes('N-OVERSTAY-WARDEN'))
    fail('no N-OVERSTAY-WARDEN for the warden');
  demoJob('run', 'job_night_sweep');
  ok(`G. demo:job overstay/escalate ${visitA.code} → host then warden alerted; night sweep ran`);

  // ---- H. force check-out + ban → refused at the gate ----
  const forced = await call('POST', `/v1/admin/visits/${visitB.id}/force-checkout`, {
    auth: warden,
    headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: { reason: 'Demo: not who the host expected' },
  });
  expectStatus(forced, 200, 'force check-out');
  const visitorB = (await call('GET', '/v1/me', { auth: guestB })).body.id as string;
  expectStatus(
    await call('POST', '/v1/admin/bans', {
      auth: warden,
      headers: adminHeaders,
      body: { visitorId: visitorB, allHostels: false, reason: 'Demo ban' },
    }),
    201,
    'ban guest',
  );
  s = await scan(guestB, gate);
  const sidB2 = s.created.body.scanSessionId as string;
  const banned = await call('POST', `/v1/scan-sessions/${sidB2}/walk-in`, {
    auth: guestB,
    headers: { 'x-scan-nonce': s.nonce, 'idempotency-key': randomUUID() },
    body: {
      hostId: host.residentId,
      type: 'day',
      durationMinutes: 60,
      photoId: await sessionPhoto(guestB, sidB2, s.nonce),
    },
  });
  if (banned.body?.error?.code !== 'VISITOR_BANNED')
    fail('banned guest was not refused with VISITOR_BANNED', banned.body);
  ok('H. warden force-checks-out and bans Kavya; her next request is refused');

  await demoClock('reset');
  console.log(
    `\nAll ${step} checks passed. The demo database now holds test data — restart \`pnpm demo\` before presenting.`,
  );
}

main().catch(async (err: unknown) => {
  await call('POST', '/__demo/clock', { body: { at: 'reset' } }).catch(() => undefined);
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
  if (!(err instanceof SmokeFailure) && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
