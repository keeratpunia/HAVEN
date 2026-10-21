#!/usr/bin/env node
/**
 * Captures the report's screenshots from the real app: starts `pnpm demo` (seeded demo
 * data only), drives it with Playwright (fake camera, fake GPS) and saves PNGs to
 * docs/report/screenshots/. Phones at the SDD viewport (360×640); gate, warden and office
 * screens at a desktop viewport. The gate location is forced to the demo default
 * (12.9716, 77.5946) so no real coordinates from demo.config.json can appear.
 * Guests use the SDD test numbers (+91 99999 000xx) and the fixed code 123456. Each guest's
 * browser gets its own illustrated face (scripts/fake_faces.py) as the fake camera, so live
 * photos look like photos of that guest without showing any real person.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const OUT = path.join(here, '..', 'screenshots');
mkdirSync(OUT, { recursive: true });
const WEB = 'http://localhost:8081';
const API = 'http://127.0.0.1:8080';
const LAT = 12.9716;
const LNG = 77.5946;
const PHONE = { width: 360, height: 640 };
const DESKTOP = { width: 1280, height: 800 };

// ---- demo stack ----
function sh(cmd, env = {}) {
  return spawn(cmd, {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}
// Midday IST today (07:30 UTC): the demo clock is moved there below, and the seeded
// dashboard visits are placed around the same moment so the two agree.
const MIDDAY = new Date();
MIDDAY.setUTCHours(7, 30, 0, 0);
spawnSync('pnpm demo:reset', { cwd: ROOT, shell: true, stdio: 'inherit' });
const demo = sh('pnpm demo', {
  DEMO_GATE_LAT: String(LAT),
  DEMO_GATE_LNG: String(LNG),
  DEMO_GATE_RADIUS_M: '150',
  DEMO_SEED_AT: MIDDAY.toISOString(),
});
let log = '';
demo.stdout.on('data', (b) => (log += b.toString()));
demo.stderr.on('data', (b) => (log += b.toString()));
function stopDemo() {
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/pid', String(demo.pid), '/T', '/F'], { stdio: 'ignore' });
  else demo.kill();
  spawnSync('pnpm demo:reset', { cwd: ROOT, shell: true, stdio: 'ignore' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 400 && !log.includes('HAVEN demo is up'); i++) await sleep(1_500);
if (!log.includes('HAVEN demo is up')) {
  console.error(log.slice(-3000));
  stopDemo();
  throw new Error('demo did not start');
}
const pairing = /pairing code ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(log)?.[1];

async function demoNow() {
  const r = await fetch(`${API}/__demo/clock`);
  return new Date((await r.json()).now);
}
async function gateToken(stepsAgo = 0) {
  const step = BigInt(Math.floor((await demoNow()).getTime() / 10_000) - stepsAgo);
  const mac = createHmac('sha256', Buffer.alloc(32, 19))
    .update(`HVG1|GH8DEM|${step}`)
    .digest()
    .subarray(0, 10);
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of mac) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return `GH8DEM.${step}.${out}`;
}

// ---- browsers: one per fake-camera face ----
const FACES = path.join(here, '..', '.build', 'faces');
const made = spawnSync(process.env.PYTHON ?? 'python', [path.join(here, 'fake_faces.py'), FACES], {
  stdio: 'inherit',
});
if (made.status !== 0) throw new Error('fake_faces.py failed');
const browsers = {};
async function browserFor(face) {
  browsers[face] ??= await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${path.join(FACES, `face-${face}.y4m`)}`,
    ],
  });
  return browsers[face];
}
async function context(viewport, extra = {}, face = 'c') {
  const ctx = await (
    await browserFor(face)
  ).newContext({
    viewport,
    deviceScaleFactor: 2,
    permissions: ['camera', 'geolocation'],
    geolocation: { latitude: LAT, longitude: LNG, accuracy: 10 },
    ...extra,
  });
  ctx.setDefaultTimeout(60_000);
  return ctx;
}
async function shot(page, name, opts = {}) {
  // No focused or highlighted input in a screenshot.
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  await sleep(opts.settle ?? 800);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: opts.fullPage ?? false });
  console.log(`captured ${name}`);
}
async function staffSignIn(page, email) {
  await page.goto(`${WEB}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
async function guestOtp(page, phone) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByText('Enter the code').waitFor();
  for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1} of 6`).fill('123456'[i]);
}
async function profile(page, name, shotName) {
  await page.getByText('About you').waitFor();
  await page.getByLabel('Full name').fill(name);
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByRole('checkbox', { name: 'I am 18 years or older' }).click();
  await page.getByRole('checkbox', { name: 'I agree to the privacy notice' }).click();
  if (shotName) {
    await page
      .getByRole('checkbox', { name: 'I agree to the privacy notice' })
      .scrollIntoViewIfNeeded();
    await shot(page, shotName);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await livePhoto(page);
}
// Chromium restarts the fake video at its first frame each time the camera opens, so a
// fixed delay would give a guest two identical photos (the API refuses the second as
// PHOTO_REUSED). Each photo waits a little longer than the one before.
let photoCount = 0;
async function livePhoto(page, settleMs = 1_500) {
  await page.getByRole('button', { name: 'Take photo' }).waitFor({ state: 'visible' });
  await sleep(settleMs + (photoCount++ % 12) * 300);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();
}

try {
  // ---- gate display (desktop) ----
  const gateCtx = await context(DESKTOP);
  const gate = await gateCtx.newPage();
  // The web server can take a moment after the demo reports it is up.
  for (let i = 0; ; i++) {
    try {
      await gate.goto(`${WEB}/gate`);
      break;
    } catch (err) {
      if (i >= 20) throw err;
      await sleep(3_000);
    }
  }
  await gate.waitForURL(/\/gate\/pair/);
  await gate.getByLabel('Pairing code').fill(pairing.replace('-', ''));
  await gate.getByRole('button', { name: 'Pair' }).click();
  await gate.getByText('Guests: scan with your phone camera to enter or leave').waitFor();
  // Only now move the demo clock: the pairing code was issued at the real time with a
  // 10-minute life, so pairing must happen before the clock jumps.
  // Midday IST: every visiting rule allows the happy path, whatever the real time.
  await fetch(`${API}/__demo/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: '13:00' }),
  });
  await shot(gate, 'd01-gate-display', { settle: 1_500 });

  // ---- resident Priya (phone) ----
  const priyaCtx = await context(PHONE);
  const priya = await priyaCtx.newPage();
  await staffSignIn(priya, 'priya@haven.demo');
  await priya.waitForURL(/\/home$/);
  await priya.getByText('Inside now').waitFor();
  await shot(priya, 'r01-resident-home', { settle: 1_500 });

  const now = await demoNow();
  await priya.getByRole('tab', { name: 'Invite' }).click();
  await priya.getByLabel('Guest name').fill('Simran Kaur');
  await priya.getByLabel('Phone number').fill('9999900001');
  await priya.getByLabel('Start').fill('13:15');
  await priya.getByLabel('End').fill('16:15');
  const create = priya.getByRole('button', { name: 'Create invite' });
  await create.scrollIntoViewIfNeeded();
  await priya.waitForFunction(() => {
    const b = [...document.querySelectorAll('[role=button]')].find((e) =>
      e.textContent?.includes('Create invite'),
    );
    return b && b.getAttribute('aria-disabled') !== 'true';
  });
  await shot(priya, 'r02-create-invite');
  await create.click();
  await priya.getByText('Share invite').waitFor();
  const linkLabel = await priya.getByLabel(/^Invite link /).getAttribute('aria-label');
  const inviteUrl = linkLabel.replace(/^Invite link /, '').trim();
  void now;

  // ---- guest A: invite → OTP → profile → check in (phone) ----
  const aCtx = await context(PHONE, {}, 'a');
  const a = await aCtx.newPage();
  await a.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, WEB));
  await a.getByText('invited you to', { exact: false }).waitFor();
  await shot(a, 'g01-invite-landing');
  await a.getByRole('button', { name: 'Continue' }).click();
  await guestOtp(a, '9999900001');
  await shot(a, 'g02-otp');
  await a.getByRole('button', { name: 'Verify' }).click();
  await profile(a, 'Simran Kaur', 'g03-profile-consent');
  await a.waitForURL(/\/visits/);
  await a.goto(`${WEB}/g/${await gateToken()}`);
  await a.getByRole('button', { name: 'Allow location' }).click();
  await a.getByRole('button', { name: 'Check in' }).waitFor();
  await shot(a, 'g04-scan-check-in');
  await a.getByRole('button', { name: 'Check in' }).click();
  await livePhoto(a, 2_000);
  await a.getByText("You're checked in").waitFor();
  await shot(a, 'g05-checked-in');

  // ---- Priya: arrival confirmation (R-09) ----
  const arrived = priya.getByRole('button', { name: /^Simran Kaur, / }).first();
  await priya.goto(`${WEB}/home`);
  await arrived.waitFor({ timeout: 60_000 });
  await arrived.click();
  await priya.waitForURL(/\/arrival\//);
  await priya.getByRole('button', { name: "Yes, that's my guest" }).waitFor();
  // The page scrolls inside the app, not the window: bring the last button fully into view.
  await priya.getByRole('button', { name: /Not my guest/ }).scrollIntoViewIfNeeded();
  await shot(priya, 'r04-arrival-confirm', { settle: 2_000 });
  await priya.getByRole('button', { name: "Yes, that's my guest" }).click();

  // ---- guest B: walk-in → waiting → approved (phone) ----
  const bCtx = await context(PHONE, {}, 'b');
  const b = await bCtx.newPage();
  await b.goto(`${WEB}/login`);
  await guestOtp(b, '9999900002');
  await b.getByRole('button', { name: 'Verify' }).click();
  await profile(b, 'Kavya Nair');
  await b.waitForURL(/\/visits/);
  await b.goto(`${WEB}/g/${await gateToken()}`);
  await b.getByRole('button', { name: 'Allow location' }).click();
  await b.getByText('Find your host').waitFor();
  await b.getByLabel('Room number').fill('101');
  await b.getByRole('button', { name: 'Search' }).click();
  await b.getByRole('button', { name: 'Select Priya S.' }).click();
  await b.getByText('Visit type').waitFor();
  await b.getByRole('button', { name: 'Continue' }).click();
  await livePhoto(b, 2_500);
  await b.getByText('Waiting for host').waitFor();
  await shot(b, 'g06-walk-in-waiting');

  await priya.goto(`${WEB}/home`);
  const walkIn = priya.getByRole('button', { name: /^Kavya Nair, / }).first();
  await walkIn.waitFor({ timeout: 60_000 });
  await walkIn.click();
  await priya.waitForURL(/\/walk-in\//);
  await priya.getByRole('button', { name: 'Approve' }).waitFor();
  await shot(priya, 'r03-walk-in-approval', { settle: 2_000 });
  await priya.getByRole('button', { name: 'Approve' }).click();
  await b.getByText("You're checked in").waitFor({ timeout: 30_000 });

  // ---- Priya: overnight request preview (R-11) ----
  await priya.goto(`${WEB}/home`);
  await priya.getByRole('button', { name: 'Overnight' }).click();
  await priya.getByLabel('Guest name').fill('Meera Joshi');
  await priya.getByLabel('Phone number').fill('9999900003');
  await priya.getByRole('tab', { name: 'Female' }).click();
  await priya.getByRole('tab', { name: 'Hostel guest room' }).click();
  const d = await demoNow();
  const day = (n) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  await priya.getByRole('textbox', { name: 'Arrival', exact: true }).fill(day(1));
  await priya.getByRole('textbox', { name: 'Departure', exact: true }).fill(day(2));
  await priya.getByText(/night · ₹/).waitFor();
  await priya.getByRole('button', { name: 'Send to warden' }).scrollIntoViewIfNeeded();
  await shot(priya, 'r05-overnight-request');
  await priya.getByRole('button', { name: 'Send to warden' }).click();
  await priya.getByText('Sent to the warden').waitFor();

  // ---- warden (desktop) ----
  const wCtx = await context(DESKTOP);
  const w = await wCtx.newPage();
  await staffSignIn(w, 'warden@haven.demo');
  await w.waitForURL(/\/warden$/);
  await w.getByText('Inside now').first().waitFor();
  await shot(w, 'w01-warden-dashboard', { settle: 2_500 });
  await w.goto(`${WEB}/warden/inside`);
  await w.getByRole('button', { name: /^Kavya Nair, guest of Priya S\./ }).waitFor();
  await shot(w, 'w02-inside-now', { settle: 1_500 });
  await w.getByRole('button', { name: /^Kavya Nair, guest of Priya S\./ }).click();
  await w.waitForURL(/\/warden\/visits\//);
  await w.getByText('Timeline').waitFor();
  await shot(w, 'w03-visit-photos', { settle: 2_500 });
  await w.getByText('Timeline').scrollIntoViewIfNeeded();
  await shot(w, 'w04-visit-timeline', { settle: 1_000 });
  await w.goto(`${WEB}/warden/approvals`);
  await w
    .getByText(/Meera Joshi/)
    .first()
    .waitFor();
  await shot(w, 'w05-approvals', { settle: 1_500 });
  await w.getByRole('button', { name: 'Approve request for Meera Joshi' }).click();
  await w.getByText(/Approved Meera Joshi/).waitFor();
  await w.goto(`${WEB}/warden/rules`);
  await sleep(2_500);
  await shot(w, 'w06-rules');
  await w.goto(`${WEB}/warden/gates`);
  await w.getByRole('button', { name: 'Add device' }).first().waitFor();
  await shot(w, 'w07-gates', { settle: 1_500 });

  // ---- office (desktop) ----
  const oCtx = await context(DESKTOP);
  const o = await oCtx.newPage();
  await staffSignIn(o, 'office@haven.demo');
  await o.waitForURL(/\/office\/charges$/);
  await o.getByText(/₹150/).first().waitFor();
  await shot(o, 'o01-office-charges', { settle: 1_500 });

  // ---- rules and security in action (phone) ----
  // The location prompt only shows until the site has asked once in this browser.
  async function allowLocation(page) {
    await page
      .getByRole('button', { name: 'Allow location' })
      .click({ timeout: 8_000 })
      .catch(() => {});
  }
  async function scene(name, fn) {
    try {
      await fn();
    } catch (err) {
      console.error(`scene ${name} failed: ${err.message.split('\n')[0]}`);
      const apiErrors = log
        .split('\n')
        .filter((l) => /"statusCode":[45]\d\d|"code":"[A-Z_]+"/.test(l));
      console.error(apiErrors.slice(-8).join('\n'));
      for (const ctx of [...Object.values(browsers)].flatMap((br) => br.contexts()))
        for (const pg of ctx.pages())
          await pg
            .screenshot({
              path: path.join(
                here,
                '..',
                '.build',
                `fail-${name}-${Math.random().toString(36).slice(2, 6)}.png`,
              ),
            })
            .catch(() => {});
      process.exitCode = 1;
    }
  }
  async function requestWalkIn(page, room, host) {
    await page.goto(`${WEB}/g/${await gateToken()}`);
    await allowLocation(page);
    await page.getByText('Find your host').waitFor();
    await page.getByLabel('Room number').fill(room);
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: host }).click();
    await page.getByText('Visit type').waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();
    await livePhoto(page, 2_500);
  }
  async function newGuest(phone, name, face) {
    const ctx = await context(PHONE, {}, face);
    const page = await ctx.newPage();
    await page.goto(`${WEB}/login`);
    await guestOtp(page, phone);
    await page.getByRole('button', { name: 'Verify' }).click();
    await profile(page, name);
    await page.waitForURL(/\/visits/);
    return page;
  }

  await scene('code-changed', async () => {
    // (b) An old QR code: a screenshot of the gate passed on two minutes later.
    await b.goto(`${WEB}/g/${await gateToken(12)}`);
    await allowLocation(b);
    await b.getByText('That code has changed').waitFor();
    await shot(b, 's02-code-changed');
  });
  await scene('ask-host', async () => {
    // (c) GPS says the phone is about 1 km from the gate, three times.
    const fCtx = await context(
      PHONE,
      { geolocation: { latitude: LAT + 0.009, longitude: LNG, accuracy: 10 } },
      'c',
    );
    const f = await fCtx.newPage();
    await f.goto(`${WEB}/g/${await gateToken()}`);
    await allowLocation(f);
    for (let i = 0; i < 2; i++) {
      await f.getByRole('button', { name: 'Try again' }).click();
      await sleep(1_500);
    }
    await f.getByRole('button', { name: 'Ask host to confirm' }).waitFor();
    await shot(f, 's03-ask-host');
  });
  await scene('banned', async () => {
    // (d) A guest the warden has banned (after an earlier, cancelled walk-in).
    const dPage = await newGuest('9999900004', 'Tanvi Gupta', 'c');
    await requestWalkIn(dPage, '102', /^Select Fatima/);
    await dPage.getByRole('button', { name: 'Cancel request' }).click();
    await sleep(1_500);
    await w.goto(`${WEB}/warden/bans`);
    await w.getByLabel('Find the guest: name, phone or visit code').fill('Tanvi');
    await w.getByRole('button', { name: 'Find guest' }).click();
    await w
      .getByRole('button', { name: /^Tanvi Gupta · / })
      .first()
      .click();
    await w.getByRole('button', { name: 'Ban guest' }).click();
    await w.getByLabel('Reason').fill('Demo: entered without registering');
    await w.getByRole('button', { name: 'Confirm ban' }).click();
    await w.getByText('Guest banned.').waitFor();
    const banned = dPage.getByText("You can't enter this hostel");
    await dPage.goto(`${WEB}/g/${await gateToken()}`);
    await allowLocation(dPage);
    await dPage.getByText('Find your host').or(banned).first().waitFor();
    if (!(await banned.isVisible())) {
      await dPage.getByLabel('Room number').fill('102');
      await dPage.getByRole('button', { name: 'Search' }).click();
      await dPage.getByRole('button', { name: /^Select Fatima/ }).click();
      await dPage.getByText('Visit type').waitFor();
      await dPage.getByRole('button', { name: 'Continue' }).click();
      await livePhoto(dPage, 2_500);
    }
    await banned.waitFor();
    await shot(dPage, 's04-banned');
  });
  await scene('entry-closed', async () => {
    // (a) A walk-in at 20:05: entry for day guests closed at 20:00 (BR-02).
    const ePage = await newGuest('9999900005', 'Ishita Verma', 'a');
    await fetch(`${API}/__demo/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: '20:05' }),
    });
    await requestWalkIn(ePage, '102', /^Select Fatima/);
    await ePage.getByText('Entry has closed for today').waitFor();
    await shot(ePage, 's01-entry-closed');
  });
} finally {
  writeFileSync(path.join(here, '..', '.build', 'demo.log'), log);
  for (const br of Object.values(browsers)) await br.close();
  stopDemo();
}
console.log('screenshots done');
