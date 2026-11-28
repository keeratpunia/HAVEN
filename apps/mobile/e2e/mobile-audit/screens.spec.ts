import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';

/**
 * Every screen of every role at phone size (see ../mobile-audit.config.ts). Each screen
 * gets a screenshot in docs/screenshots-mobile/<role>/<screen>.<project>.png and is
 * checked for:
 *   - horizontal scrolling (page wider than the viewport),
 *   - visible elements running off the right edge,
 *   - tap targets (buttons, links, inputs, checkboxes, tabs) smaller than 44 × 44 px.
 * Problems go to test-results/mobile-audit/<project>.json. The run does not fail on
 * problems: it is a worklist, re-run after each fix.
 *
 * Seed data comes from `pnpm demo` (apps/api/scripts/demo-db.ts).
 */

const API = process.env.AUDIT_API_URL ?? 'http://localhost:8080';
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots-mobile');
const RESULTS = path.join(ROOT, 'apps', 'mobile', 'test-results', 'mobile-audit');
const MIN_TAP = 44;

interface Problem {
  role: string;
  screen: string;
  kind: 'horizontal-scroll' | 'off-screen' | 'small-tap-target';
  detail: string;
}
const problems: Problem[] = [];

test.afterAll(({}, info) => {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${info.project.name}.json`), JSON.stringify(problems, null, 2));
  // eslint-disable-next-line no-console -- the audit reports to the terminal
  console.log(
    `${problems.length} problem(s) → test-results/mobile-audit/${info.project.name}.json`,
  );
});

// Not 'networkidle': staff screens hold a live-updates stream open, so it never comes.
async function settle(page: Page) {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForTimeout(2_500);
}

async function audit(page: Page, role: string, screen: string, project: string) {
  await settle(page);
  const found = await page.evaluate((minTap) => {
    const out: { kind: string; detail: string }[] = [];
    const vw = window.innerWidth;
    const doc = document.scrollingElement ?? document.documentElement;
    if (doc.scrollWidth > vw + 1) {
      out.push({ kind: 'horizontal-scroll', detail: `page ${doc.scrollWidth}px > ${vw}px` });
    }
    const label = (el: Element) =>
      (
        el.getAttribute('aria-label') ||
        (el as HTMLElement).innerText ||
        el.getAttribute('placeholder') ||
        el.tagName
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 50);
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
    };
    // Elements whose own box leaves the viewport while their scroll parent doesn't scroll
    // sideways (horizontal carousels/rows that scroll on purpose are skipped).
    const scrollsSideways = (el: Element | null): boolean => {
      for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && p.scrollWidth > p.clientWidth)
          return true;
      }
      return false;
    };
    const seenOff = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!visible(el) || el.children.length > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.left < vw && !scrollsSideways(el)) {
        const d = `"${label(el)}" right edge ${Math.round(r.right)}px`;
        if (!seenOff.has(d)) out.push({ kind: 'off-screen', detail: d });
        seenOff.add(d);
      }
    }
    const tappable =
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [role=radio], [role=switch]';
    for (const el of Array.from(document.querySelectorAll(tappable))) {
      if (!visible(el)) continue;
      if (el.parentElement?.closest(tappable)) continue; // nested inside a bigger target
      const r = el.getBoundingClientRect();
      if (r.width < minTap || r.height < minTap) {
        out.push({
          kind: 'small-tap-target',
          detail: `"${label(el)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
        });
      }
    }
    return out;
  }, MIN_TAP);
  for (const f of found)
    problems.push({ role, screen, kind: f.kind as Problem['kind'], detail: f.detail });
  const dir = path.join(SHOTS, role);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${screen}.${project}.png`) });
}

async function devLogin(page: Page, email: string) {
  await page.context().clearCookies();
  const res = await page.request.post(`${API}/v1/auth/dev-login`, { data: { email } });
  if (!res.ok()) throw new Error(`dev-login ${email}: ${res.status()}`);
}

async function guestLogin(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.request.post(`${API}/v1/auth/otp/request`, {
    data: { phone, purpose: 'guest_login' },
  });
  const res = await page.request.post(`${API}/v1/auth/otp/verify`, {
    data: { phone, code: '123456', purpose: 'guest_login' },
  });
  if (!res.ok()) throw new Error(`guest login ${phone}: ${res.status()}`);
  return (await res.json()) as { accessToken: string };
}

/** Gives the signed-in guest a finished profile (name, 18+, consent, photo) via the API. */
async function finishGuestProfile(page: Page, accessToken: string, name: string) {
  const auth = { Authorization: `Bearer ${accessToken}` };
  await page.request.patch(`${API}/v1/me`, {
    headers: auth,
    data: { fullName: name, gender: 'female', isAdultConfirmed: true },
  });
  const consentVersion = (
    (await (await page.request.get(`${API}/v1/me`, { headers: auth })).json()) as {
      consentVersion?: string;
    }
  ).consentVersion;
  await page.request.post(`${API}/v1/me/consent`, {
    headers: auth,
    data: { version: consentVersion ?? 'privacy-2026-10-19', isAdult: true },
  });
  // Any demo-seeded JPEG will do as the selfie (generated by demo-db.ts).
  const photos = path.join(ROOT, 'apps', 'api', '.demo-media', 'visitor-photos');
  const { readdirSync } = await import('node:fs');
  const dir = readdirSync(photos)[0];
  if (!dir) return;
  await page.request.post(`${API}/v1/me/profile-photo`, {
    headers: auth,
    multipart: {
      photo: {
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        buffer: readFileSync(path.join(photos, dir, 'profile.jpg')),
      },
    },
  });
}

async function bearer(page: Page): Promise<string> {
  const res = await page.request.post(`${API}/v1/auth/refresh`, { data: {} });
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function apiGet<T>(page: Page, url: string, token: string, hostelId?: string): Promise<T> {
  const res = await page.request.get(`${API}${url}`, {
    headers: { Authorization: `Bearer ${token}`, ...(hostelId ? { 'X-Hostel-Id': hostelId } : {}) },
  });
  if (!res.ok()) throw new Error(`GET ${url}: ${res.status()}`);
  return (await res.json()) as T;
}

async function visit(page: Page, role: string, screen: string, url: string, project: string) {
  await page.goto(url);
  await audit(page, role, screen, project);
}

/** The demo gate's live QR token (mirrors apps/api/src/gate/token.ts; demo-constants.ts). */
function demoGateToken(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const step = BigInt(Math.floor(Date.now() / 10_000));
  const mac = createHmac('sha256', Buffer.alloc(32, 19))
    .update(`HVG1|GH8DEM|${step.toString()}`)
    .digest()
    .subarray(0, 10);
  let bits = 0;
  let value = 0;
  let enc = '';
  for (const byte of mac) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      enc += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) enc += alphabet[(value << (5 - bits)) & 31];
  return `GH8DEM.${step.toString()}.${enc}`;
}

/** The demo gate position, read at run time from the local demo.config.json (never committed). */
function demoGatePosition(): { latitude: number; longitude: number } | null {
  const file = path.join(ROOT, 'demo.config.json');
  if (!existsSync(file)) return null;
  const cfg = JSON.parse(readFileSync(file, 'utf-8')) as { gate?: { lat?: number; lng?: number } };
  if (typeof cfg.gate?.lat !== 'number' || typeof cfg.gate.lng !== 'number') return null;
  return { latitude: cfg.gate.lat, longitude: cfg.gate.lng };
}

test('public and sign-in screens', async ({ page }, info) => {
  const p = info.project.name;
  await page.context().clearCookies();
  await visit(page, 'public', 'landing', '/', p);
  await visit(page, 'public', 'privacy', '/privacy', p);
  await visit(page, 'public', 'sign-in', '/sign-in', p);
  await visit(page, 'guest', 'login', '/login', p);
});

test('guest screens', async ({ page }, info) => {
  const p = info.project.name;
  // A brand-new guest: the "About you" + profile photo step.
  await guestLogin(page, '+919999900009');
  await visit(page, 'guest', 'profile-new', '/profile', p);

  // A guest with a finished profile and a visit (seeded guests can't sign in by OTP, so
  // finish phone 08's profile through the API first if it isn't finished yet).
  const guest = await guestLogin(page, '+919999900008');
  await finishGuestProfile(page, guest.accessToken, 'Audit Guest');
  await visit(page, 'guest', 'visits', '/visits', p);
  await visit(page, 'guest', 'my-profile', '/my-profile', p);

  // Invite landing: a fresh link for the seeded unclaimed invite VDEM004.
  await devLogin(page, 'priya@haven.demo');
  const token = await bearer(page);
  const hosted = await apiGet<{ items: { id: string; code: string }[] }>(
    page,
    '/v1/me/hosted-visits',
    token,
  );
  const invite = hosted.items.find((v) => v.code === 'VDEM004');
  if (invite) {
    const res = await page.request.post(`${API}/v1/visits/${invite.id}/invite-link`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { inviteUrl } = (await res.json()) as { inviteUrl: string };
    await page.context().clearCookies();
    await visit(page, 'guest', 'invite-landing', new URL(inviteUrl).pathname, p);
  }

  // Gate landing at the gate's own position.
  const pos = demoGatePosition();
  if (pos) await page.context().setGeolocation({ ...pos, accuracy: 10 });
  await guestLogin(page, '+919999900008');
  await visit(page, 'guest', 'gate-landing', `/g/${demoGateToken()}`, p);
  await page.waitForTimeout(4_000);
  await audit(page, 'guest', 'gate-landing-after-location', p);
});

test('resident screens', async ({ page }, info) => {
  const p = info.project.name;
  await devLogin(page, 'priya@haven.demo');
  for (const [screen, url] of [
    ['home', '/home'],
    ['invite', '/invite'],
    ['guests', '/guests'],
    ['overnight', '/overnight'],
    ['notifications', '/notifications'],
    ['charges', '/charges'],
    ['account', '/account'],
    ['assist', '/assist'],
  ] as const) {
    await visit(page, 'resident', screen, url, p);
  }
  const token = await bearer(page);
  const hosted = await apiGet<{ items: { id: string; code: string; status: string }[] }>(
    page,
    '/v1/me/hosted-visits',
    token,
  );
  const inside = hosted.items.find((v) => v.status === 'inside');
  if (inside) {
    await visit(page, 'resident', 'visit-detail', `/visit/${inside.id}`, p);
    await visit(page, 'resident', 'arrival', `/arrival/${inside.id}`, p);
  }
  // Pending verification (seeded Neha).
  await devLogin(page, 'neha@haven.demo');
  await visit(page, 'resident', 'pending', '/pending', p);
});

test('warden and admin screens', async ({ page }, info) => {
  const p = info.project.name;
  await devLogin(page, 'warden@haven.demo');
  for (const [screen, url] of [
    ['dashboard', '/warden'],
    ['inside', '/warden/inside'],
    ['approvals', '/warden/approvals'],
    ['residents', '/warden/residents'],
    ['more', '/warden/more'],
    ['visits', '/warden/visits'],
    ['emergency', '/warden/emergency'],
    ['bans', '/warden/bans'],
    ['rules', '/warden/rules'],
    ['gates', '/warden/gates'],
    ['staff', '/warden/staff'],
    ['charges', '/warden/charges'],
    ['audit', '/warden/audit'],
    ['reports', '/warden/reports'],
  ] as const) {
    await visit(page, 'warden', screen, url, p);
  }
  // A visit detail (the host-confirmed, location-not-verified one has the most on it).
  await page.goto('/warden/inside');
  await settle(page);
  const first = page.getByText('Riya Das').first();
  if (await first.count()) {
    await first.click();
    await audit(page, 'warden', 'visit-detail', p);
  }
  // W-08: residents sorted by most guests, then one resident's detail (DEC-031).
  await page.goto('/warden/residents');
  await settle(page);
  const residentsFilters = page.getByRole('button', { name: /^Filters/ });
  if (await residentsFilters.count()) {
    await residentsFilters.first().click();
    await page.getByRole('tab', { name: 'Most guests' }).click();
    await page.getByRole('button', { name: 'Show results' }).click();
  } else {
    await page.getByRole('tab', { name: 'Most guests' }).click();
  }
  await audit(page, 'warden', 'residents-most-guests', p);
  await page.getByRole('button', { name: /^Priya Sharma, room 101/ }).click();
  await page.getByText('As a host').waitFor({ timeout: 30_000 });
  await audit(page, 'warden', 'resident-detail', p);
  // The phone filter sheet on visit search.
  await page.goto('/warden/visits');
  await settle(page);
  const filters = page.getByRole('button', { name: /^Filters/ });
  if (await filters.count()) {
    await filters.first().click();
    await audit(page, 'warden', 'visits-filters', p);
  }

  await devLogin(page, 'admin@haven.demo');
  for (const [screen, url] of [
    ['dashboard', '/warden'],
    ['more', '/warden/more'],
    ['gates', '/warden/gates'],
    ['residents', '/warden/residents'],
  ] as const) {
    await visit(page, 'admin', screen, url, p);
  }
});

test('office screens', async ({ page }, info) => {
  const p = info.project.name;
  await devLogin(page, 'office@haven.demo');
  await visit(page, 'office', 'charges', '/office/charges', p);
});

test('gate display (landscape)', async ({ page }, info) => {
  const p = info.project.name;
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.context().clearCookies();
  await visit(page, 'gate', 'pair', '/gate/pair', p);
});
