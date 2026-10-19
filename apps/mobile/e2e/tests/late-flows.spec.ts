import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FIXED_NOW, generateTestGateToken, STEP_MS } from '../gateTestToken.js';

/**
 * Flows that need the camera refused or time to pass (FINAL-QA-REPORT item 13). They
 * run last (project `late`), because moving the E2E server's injected clock would
 * otherwise disturb every spec whose QR tokens are computed for the frozen "now". The
 * clock is put back afterwards.
 *
 * - E-17: camera denied → G-16 with how to enable it; no check-in without a photo.
 * - FR-70: a walk-in nobody answers expires after 10 minutes and the guest's screen
 *   says so (§13.6 WALK_IN_EXPIRED).
 * - F10: overstay → host and guest told → 30 minutes later the warden is told → the
 *   warden force-checks-out the guest.
 *
 * The guest is the walk-in guest from gate-retry-and-walkin (every test phone is taken);
 * the host is Kavya (room 106): by now Priya has 3 day guests inside (BR-11).
 */

const API = process.env.E2E_API_URL ?? 'http://localhost:8080';
const WALK_IN_SESSION = path.join(__dirname, '..', '..', 'test-results', 'walk-in-guest.json');
const MIN = 60_000;
const openContexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

async function setServerTime(at: Date | null) {
  const res = await fetch(`${API}/__e2e/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(at ? { at: at.toISOString() } : { reset: true }),
  });
  expect(res.ok).toBe(true);
}

async function runJob(name: 'job_expire_walkins' | 'job_flag_overstays') {
  const res = await fetch(`${API}/__e2e/jobs/${name}`, { method: 'POST' });
  expect(res.ok).toBe(true);
}

async function notificationKinds(code: string): Promise<string[]> {
  const res = await fetch(`${API}/__e2e/visits/${code}/notifications`);
  return ((await res.json()) as { kinds: string[] }).kinds;
}

/** A QR token for `at` (the gate screen follows the server clock). */
const tokenAt = (at: Date) =>
  generateTestGateToken({
    stepOffset: Math.floor((at.getTime() - E2E_FIXED_NOW.getTime()) / STEP_MS),
  });

async function guestContext(browser: Browser, opts: { denyCamera?: boolean } = {}) {
  const context = await browser.newContext({
    storageState: WALK_IN_SESSION,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
  });
  openContexts.push(context);
  if (opts.denyCamera) {
    await context.addInitScript(() => {
      const denied = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: denied });
    });
  }
  return context;
}

async function toPhotoStep(page: Page, token: string) {
  await page.goto(`/g/${token}`);
  await expect(page.getByText('Find your host')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Room number').fill('106');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Kavya M.' }).click();
  await expect(page.getByText('Visit type')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
}

test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()));
});
test.afterAll(async () => {
  await setServerTime(null);
});

test('E-17: with the camera refused the guest sees how to allow it, and nothing is submitted', async ({
  browser,
}) => {
  const context = await guestContext(browser, { denyCamera: true });
  const page = await context.newPage();
  await toPhotoStep(page, tokenAt(E2E_FIXED_NOW));
  await expect(page.getByText('Camera is blocked')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Chrome: .*Camera → Allow\. Safari: /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toHaveCount(0);
  // Try again goes back to the live camera (still refused here) — never a file picker.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Camera is blocked')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await context.storageState({ path: WALK_IN_SESSION });
});

test('FR-70: an unanswered walk-in expires after 10 minutes and the guest is told', async ({
  browser,
}) => {
  // Clear the guest's earlier, still-pending walk-in first.
  const t1 = new Date(E2E_FIXED_NOW.getTime() + 11 * MIN);
  await setServerTime(t1);
  await runJob('job_expire_walkins');

  const context = await guestContext(browser);
  const page = await context.newPage();
  await toPhotoStep(page, tokenAt(t1));
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(2_500); // a different fake-camera frame (PHOTO_REUSED)
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 30_000 });

  await setServerTime(new Date(t1.getTime() + 11 * MIN));
  await runJob('job_expire_walkins');
  // The waiting screen polls every 3 s (FR-26) and turns into §13.6 WALK_IN_EXPIRED.
  await expect(page.getByText('No answer from Kavya')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Try calling her, then request again.')).toBeVisible();
  await context.storageState({ path: WALK_IN_SESSION });
});

test('F10: overstay → host and guest told → warden told 30 min later → forced check-out', async ({
  browser,
}) => {
  // VE2E010 (host Kavya) ends at frozen-now + 30 min; the overstay grace is 15 min (§4).
  await setServerTime(new Date(E2E_FIXED_NOW.getTime() + 46 * MIN));
  await runJob('job_flag_overstays');
  expect(await notificationKinds('VE2E010')).toEqual(['N-OVERSTAY-GUEST', 'N-OVERSTAY-HOST']);

  await setServerTime(new Date(E2E_FIXED_NOW.getTime() + 77 * MIN));
  await runJob('job_flag_overstays');
  expect(await notificationKinds('VE2E010')).toContain('N-OVERSTAY-WARDEN');

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  openContexts.push(context);
  const warden = await context.newPage();
  await warden.clock.setFixedTime(new Date(E2E_FIXED_NOW.getTime() + 77 * MIN));
  await warden.goto('/sign-in');
  await warden.getByLabel('Email').fill('e2e-warden@haven.test');
  await warden.getByRole('button', { name: 'Sign in' }).click();
  await warden.waitForURL(/\/warden$/, { timeout: 60_000 });
  await warden.goto('/warden/inside?flag=overstay');
  await warden.getByRole('button', { name: /^Overstay Tester, guest of Kavya M\./ }).click();
  await warden.waitForURL(/\/warden\/visits\/[0-9a-f-]{36}$/);
  await warden.getByRole('button', { name: 'Force check-out' }).click();
  await warden.getByLabel('Reason (required)').fill('Stayed past the visit, host unreachable');
  await warden.getByRole('button', { name: 'Force check-out' }).last().click();
  await expect(warden.getByText('Closed: forced')).toBeVisible({ timeout: 15_000 });
});
