#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Smoke test for the deployed Phase 1 test version (DEC-026, DEC-028; SDD §19.5 in
 * spirit): walks the main flows through the real web address, the same way phones do
 * — through Vercel's /v1 rewrite to the Render API, Supabase Postgres and Storage.
 *
 *   pnpm --filter @haven/api run staging:smoke -- https://haven-test.vercel.app
 *
 * Needs no secrets: it signs in with the test numbers (code 123456), pairs its own
 * temporary gate device to read the QR secret like a gate screen does, scans at the
 * gate's saved position, and removes the device again at the end (the real gate screen
 * picks up the rotated secret on its next heartbeat; the old one stays valid 120 s).
 *
 * It adds a few visits to the test data (and checks its guests out again). The visit
 * part needs visiting hours (08:00–19:45 IST); outside them it checks everything else
 * and says what it skipped.
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CONSENT_VERSION } from '@haven/shared';
import { generateGateToken } from '../src/gate/token.js';

const BASE = (
  process.argv.slice(2).find((a) => a !== '--') ??
  process.env.STAGING_URL ??
  ''
).replace(/\/+$/, '');
const CODE = '123456';
const PHONES = {
  guestA: '+919999900001',
  guestB: '+919999900002',
  resident: '+919999900005',
  warden: '+919999900007',
  office: '+919999900008',
  admin: '+919999900009',
};

let step = 0;
function ok(msg: string) {
  step += 1;
  console.log(`  ✓ ${String(step).padStart(2)}. ${msg}`);
}
function note(msg: string) {
  console.log(`  · ${msg}`);
}
class SmokeFailure extends Error {}
function fail(msg: string, detail?: unknown): never {
  throw new SmokeFailure(`${msg}${detail === undefined ? '' : `\n     ${JSON.stringify(detail)}`}`);
}

interface Res {
  status: number;
  headers: Headers;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- loose JSON in a CLI check
}
async function call(
  method: string,
  url: string,
  opts: { auth?: string; body?: unknown; headers?: Record<string, string>; form?: FormData } = {},
): Promise<Res> {
  const headers: Record<string, string> = { origin: BASE, ...opts.headers };
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  let body: FormData | string | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
function expect2xx(res: Res, what: string) {
  if (res.status < 200 || res.status > 299) fail(`${what}: got ${res.status}`, res.body);
}

async function photo(): Promise<Blob> {
  // Random colours: a repeated photo would be refused as PHOTO_REUSED (§9.4).
  const n = () => Math.floor(Math.random() * 256);
  const buf = await sharp({
    create: { width: 240, height: 240, channels: 3, background: { r: n(), g: n(), b: n() } },
  })
    .jpeg()
    .toBuffer();
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' });
}

async function signIn(phone: string, what: string): Promise<string> {
  const res = await call('POST', '/v1/auth/test-sign-in', { body: { phone, code: CODE } });
  expect2xx(res, `test sign-in as ${what}`);
  return res.body.accessToken as string;
}

async function guest(phone: string, name: string): Promise<string> {
  const v = await call('POST', '/v1/auth/otp/verify', {
    body: { phone, code: CODE, purpose: 'guest_login' },
  });
  expect2xx(v, `guest sign-in ${phone}`);
  const token = v.body.accessToken as string;
  if (!v.body.principal?.profileComplete) {
    expect2xx(
      await call('PATCH', '/v1/me', {
        auth: token,
        body: { fullName: name, gender: 'female', isAdultConfirmed: true },
      }),
      'profile name',
    );
    expect2xx(
      await call('POST', '/v1/me/consent', {
        auth: token,
        body: { version: CONSENT_VERSION, isAdult: true },
      }),
      'consent',
    );
    const form = new FormData();
    form.append('photo', await photo(), 'selfie.jpg');
    expect2xx(await call('POST', '/v1/me/profile-photo', { auth: token, form }), 'profile photo');
  }
  return token;
}

interface Gate {
  id: string;
  code: string;
  lat: number | null;
  lng: number | null;
}

async function scan(token: string, gate: Gate, secret: Buffer) {
  const gateToken = generateGateToken({ secret, gateCode: gate.code, now: new Date() });
  const nonce = `smoke-${randomUUID()}`;
  const created = await call('POST', '/v1/scan-sessions', {
    auth: token,
    body: {
      token: gateToken,
      clientNonce: nonce,
      location: { lat: gate.lat, lng: gate.lng, accuracy: 12, fixAgeMs: 1_000 },
    },
  });
  expect2xx(created, 'scan session');
  if (!created.body.gpsOk) fail('GPS check failed at the gate position', created.body);
  const id = created.body.scanSessionId as string;
  const options = await call('GET', `/v1/scan-sessions/${id}`, {
    auth: token,
    headers: { 'x-scan-nonce': nonce },
  });
  expect2xx(options, 'scan options');
  return { id, nonce, options: options.body };
}

async function sessionPhoto(token: string, sessionId: string, nonce: string) {
  const form = new FormData();
  form.append('photo', await photo(), 'photo.jpg');
  const res = await call('POST', `/v1/scan-sessions/${sessionId}/photo`, {
    auth: token,
    headers: { 'x-scan-nonce': nonce },
    form,
  });
  expect2xx(res, 'live photo upload (Supabase Storage)');
  return res.body.photoId as string;
}

async function checkOutIfInside(token: string, gate: Gate, secret: Buffer, label: string) {
  const s = await scan(token, gate, secret);
  if (!s.options.actions?.includes('check_out')) return false;
  const visit = (s.options.visits as { id: string; status: string }[]).find(
    (v) => v.status === 'inside',
  );
  if (!visit) return false;
  const out = await call('POST', `/v1/scan-sessions/${s.id}/check-out`, {
    auth: token,
    headers: { 'x-scan-nonce': s.nonce, 'idempotency-key': randomUUID() },
    body: { visitId: visit.id, photoId: await sessionPhoto(token, s.id, s.nonce) },
  });
  expect2xx(out, `${label} check-out`);
  return true;
}

function istMinutes(d: Date): number {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

async function streamCheck(token: string, hostelId: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}/v1/stream?hostelId=${encodeURIComponent(hostelId)}`, {
      headers: { authorization: `Bearer ${token}`, origin: BASE },
      signal: ctrl.signal,
    });
    if (res.status === 503) return 'polling (the API refused the stream: LISTEN self-test failed)';
    if (!res.ok || !res.body) return `polling (stream answered ${res.status})`;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    ctrl.abort();
    return text.includes('event: ping')
      ? 'live'
      : `polling (unexpected first bytes: ${text.slice(0, 40)})`;
  } catch {
    return 'polling (no first event within 15 s through the rewrite)';
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!/^https:\/\//.test(BASE)) {
    fail(
      'Give the test version address, e.g.\n     pnpm --filter @haven/api run staging:smoke -- https://haven-test.vercel.app',
    );
  }
  console.log(`HAVEN test version smoke test against ${BASE}\n`);

  // ---- 1. Web app, headers, API reachable through the rewrite (wakes Render) ----
  const page = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(30_000) });
  if (!page.ok) fail(`web app answered ${page.status}`);
  const csp = page.headers.get('content-security-policy') ?? '';
  for (const [h, want] of [
    ['strict-transport-security', 'max-age=31536000'],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
  ] as const) {
    if (!(page.headers.get(h) ?? '').includes(want)) fail(`web app header ${h} missing or wrong`);
  }
  if (!csp.includes("frame-ancestors 'none'") || !csp.includes("default-src 'self'"))
    fail('web app Content-Security-Policy missing or wrong', csp);
  const manifest = await fetch(`${BASE}/manifest.webmanifest`);
  if (!manifest.ok) fail('web manifest missing');
  ok('web app up; CSP, HSTS, nosniff, frame-deny; installable-app manifest');

  console.log('     (waking the free API — the first call can take a minute)');
  const hostels = await call('GET', '/v1/hostels');
  expect2xx(hostels, 'API through the /v1 rewrite');
  ok('API answers through the Vercel rewrite');

  // ---- 2. Real numbers refused; test sign-in for every role ----
  const real = await call('POST', '/v1/auth/otp/request', {
    body: { phone: '+919812345678', purpose: 'guest_login' },
  });
  if (real.status !== 403 || real.body?.error?.code !== 'TEST_PHONES_ONLY')
    fail('a real number was not refused', real.body);
  const realStaff = await call('POST', '/v1/auth/test-sign-in', {
    body: { phone: '+919812345678', code: CODE },
  });
  if (realStaff.status !== 403) fail('test sign-in took a real number', realStaff.body);
  ok('real numbers refused with "This is a test version…"');

  const wardenRes = await call('POST', '/v1/auth/test-sign-in', {
    body: { phone: PHONES.warden, code: CODE },
  });
  expect2xx(wardenRes, 'test sign-in as warden');
  const cookie = wardenRes.headers.get('set-cookie') ?? '';
  if (
    !/haven_rt=/.test(cookie) ||
    /domain=/i.test(cookie) ||
    !/secure/i.test(cookie) ||
    !/httponly/i.test(cookie)
  )
    fail(
      'refresh cookie is not a Secure, HttpOnly, host-only cookie',
      cookie.replace(/haven_rt=[^;]+/, 'haven_rt=…'),
    );
  const warden = wardenRes.body.accessToken as string;
  const hostelId = (wardenRes.body.principal.roles as { h: string; r: string }[]).find(
    (r) => r.r === 'warden',
  )?.h;
  if (!hostelId)
    fail('the seeded warden has no hostel — run the seed (docs/DEPLOY-TEST.md step 6)');
  const admin = await signIn(PHONES.admin, 'admin');
  const resident = await signIn(PHONES.resident, 'resident Priya');
  const office = await signIn(PHONES.office, 'office');
  ok('warden, admin, resident and office sign in by test number; first-party refresh cookie');

  // ---- 3. Warden and office screens' data ----
  const adminHeaders = { 'x-hostel-id': hostelId };
  expect2xx(
    await call('GET', '/v1/admin/dashboard', { auth: warden, headers: adminHeaders }),
    'W-01 dashboard',
  );
  expect2xx(
    await call('GET', '/v1/admin/charges', { auth: office, headers: adminHeaders }),
    'O-01 charges',
  );
  const live = await streamCheck(warden, hostelId);
  ok(`dashboard and office charges load; live updates: ${live}`);

  // ---- 4. Gate: location set; pair a temporary device for the QR secret ----
  const gates = await call('GET', '/v1/admin/gates', { auth: admin, headers: adminHeaders });
  expect2xx(gates, 'W-09 gates');
  const gate = (gates.body.items as Gate[])[0];
  if (!gate) fail('no gate — run the seed');
  if (gate.lat === null || gate.lng === null)
    fail('the gate has no location yet — set it from the admin phone (docs/DEPLOY-TEST.md step 7)');
  const pairing = await call('POST', `/v1/admin/gates/${gate.id}/pairing-codes`, {
    auth: admin,
    headers: adminHeaders,
    body: {},
  });
  expect2xx(pairing, 'pairing code');
  const paired = await call('POST', '/v1/gate-devices/pair', {
    body: {
      code: String(pairing.body.code).replace(/[^0-9A-Z]/gi, ''),
      label: 'Smoke test (temporary)',
    },
  });
  expect2xx(paired, 'pair temporary gate device');
  const secret = Buffer.from(String(paired.body.secret), 'base64');
  ok('gate has a location; a temporary gate device pairs from an admin pairing code');

  let skipped = false;
  try {
    // ---- 5. Visits, only inside visiting hours ----
    const nowIst = istMinutes(new Date());
    if (nowIst < 8 * 60 || nowIst > 19 * 60 + 45) {
      skipped = true;
      note('It is outside visiting hours (08:00–19:45 IST): skipped invite, check-in and walk-in.');
    } else {
      const now = new Date();
      const invite = await call('POST', '/v1/visits', {
        auth: resident,
        body: {
          kind: 'invite',
          guest: { name: 'Smoke Guest A', phone: PHONES.guestA, gender: 'female' },
          type: 'day',
          windowStart: now.toISOString(),
          windowEnd: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
        },
      });
      expect2xx(invite, 'create invite');
      const inviteToken = String(invite.body.inviteUrl).split('/i/')[1];
      if (!inviteToken || !String(invite.body.inviteUrl).startsWith(BASE))
        fail('invite link does not point at the test version address', invite.body.inviteUrl);
      const guestA = await guest(PHONES.guestA, 'Smoke Guest A');
      await checkOutIfInside(guestA, gate, secret, 'earlier smoke visit');
      expect2xx(
        await call('POST', `/v1/invites/${inviteToken}/claim`, { auth: guestA, body: {} }),
        'claim invite',
      );
      const me = await call('GET', '/v1/me', { auth: guestA });
      const photoUrl = me.body.profilePhoto?.url as string | undefined;
      if (!photoUrl) fail('guest has no profile photo URL', me.body);
      const media = await fetch(new URL(photoUrl, BASE), { redirect: 'follow' });
      if (!media.ok || !(media.headers.get('content-type') ?? '').startsWith('image/'))
        fail(`signed photo URL did not return an image (${media.status})`);
      ok(
        'invite to a test number; guest signs in, finishes profile, claims; photo comes back via a signed URL',
      );

      const sA = await scan(guestA, gate, secret);
      if (sA.options.actions?.[0] !== 'check_in') fail('gate did not offer Check in', sA.options);
      const visitA = (sA.options.visits as { id: string; code: string }[])[0];
      if (!visitA) fail('no visit offered', sA.options);
      const inA = await call('POST', `/v1/scan-sessions/${sA.id}/check-in`, {
        auth: guestA,
        headers: { 'x-scan-nonce': sA.nonce, 'idempotency-key': randomUUID() },
        body: { visitId: visitA.id, photoId: await sessionPhoto(guestA, sA.id, sA.nonce) },
      });
      expect2xx(inA, 'check in');
      const notes = await call('GET', '/v1/me/notifications', { auth: resident });
      const kinds = ((notes.body.items ?? notes.body) as { kind: string }[]).map((n) => n.kind);
      if (!kinds.includes('N-ARRIVED')) fail('host got no N-ARRIVED in-app notification', kinds);
      ok(`guest scans, live photo, checked in (${visitA.code}); host sees the arrival`);

      const guestB = await guest(PHONES.guestB, 'Smoke Guest B');
      await checkOutIfInside(guestB, gate, secret, 'earlier smoke walk-in');
      const sB = await scan(guestB, gate, secret);
      if (sB.options.actions?.[0] !== 'request_entry')
        fail('gate did not offer Request entry', sB.options);
      const rooms = await call('GET', `/v1/hostels/${hostelId}/rooms/101/residents`, {
        auth: guestB,
        headers: { 'x-scan-session': sB.id, 'x-scan-nonce': sB.nonce },
      });
      expect2xx(rooms, 'find your host');
      const host = (rooms.body as { residentId: string }[])[0];
      if (!host) fail('no resident in room 101', rooms.body);
      const walkIn = await call('POST', `/v1/scan-sessions/${sB.id}/walk-in`, {
        auth: guestB,
        headers: { 'x-scan-nonce': sB.nonce, 'idempotency-key': randomUUID() },
        body: {
          hostId: host.residentId,
          type: 'quick_drop',
          durationMinutes: 30,
          photoId: await sessionPhoto(guestB, sB.id, sB.nonce),
        },
      });
      expect2xx(walkIn, 'walk-in request');
      const visitB = walkIn.body.visit as { id: string; code: string };
      expect2xx(
        await call('POST', `/v1/visits/${visitB.id}/approve`, {
          auth: resident,
          headers: { 'idempotency-key': randomUUID() },
          body: {},
        }),
        'host approves walk-in',
      );
      const polled = await call('GET', `/v1/visits/${visitB.id}`, { auth: guestB });
      if (polled.body.status !== 'inside')
        fail('walk-in guest not inside after approval', polled.body);
      ok(`walk-in (${visitB.code}) approved by the host; guest inside`);

      if (!(await checkOutIfInside(guestA, gate, secret, 'guest A')))
        fail('guest A could not check out');
      if (!(await checkOutIfInside(guestB, gate, secret, 'guest B')))
        fail('guest B could not check out');
      ok('both guests check out at the gate');
    }
  } finally {
    // ---- 6. Remove the temporary device ----
    const after = await call('GET', '/v1/admin/gates', { auth: admin, headers: adminHeaders });
    const device = (
      (after.body.items as { devices: { id: string; label: string }[] }[])[0]?.devices ?? []
    ).find((d) => d.label === 'Smoke test (temporary)');
    if (device) {
      const revoked = await call('POST', `/v1/admin/gate-devices/${device.id}/revoke`, {
        auth: admin,
        headers: adminHeaders,
        body: {},
      });
      if (revoked.status >= 300)
        note(`could not remove the temporary gate device (${revoked.status}); remove it in Gates`);
    }
  }
  ok('temporary gate device removed');

  console.log(
    `\nAll ${step} checks passed${skipped ? ' (visit checks skipped outside visiting hours)' : ''}.`,
  );
}

main().catch((err: unknown) => {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
  if (!(err instanceof SmokeFailure) && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
