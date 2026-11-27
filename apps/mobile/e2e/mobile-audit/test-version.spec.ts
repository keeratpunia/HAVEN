import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Phase 1 test version's own screens (DEC-028), at phone size: the badge, sign-in by
 * test number for each role, the admin's "Set gate location to my current position"
 * and the gate screen in landscape with the badge clear of the QR. Runs only against a
 * web app built with EXPO_PUBLIC_APP_ENV=staging:
 *
 *   EXPO_PUBLIC_APP_ENV=staging pnpm demo
 *   AUDIT_TEST_VERSION=1 pnpm --filter @haven/mobile run audit:mobile -- test-version
 */
test.skip(
  !process.env.AUDIT_TEST_VERSION,
  'needs a web app built with EXPO_PUBLIC_APP_ENV=staging',
);

const SHOTS = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'screenshots-mobile',
  'test-version',
);

async function shot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.${project}.png`) });
}

async function signInWithTestNumber(page: Page, digits: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await expect(page.getByText('TEST VERSION · dummy data')).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Phone number').fill(digits);
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Sign in with test number' }).click();
}

test('sign-in, warden, admin gate tools, gate screen', async ({ page }, info) => {
  const p = info.project.name;
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await expect(page.getByText('Sign in with a test number')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'sign-in', p);

  // A real number is refused with the test-version message.
  await page.getByLabel('Phone number').fill('9812345678');
  await page.getByLabel('Code').fill('123456');
  await page.getByRole('button', { name: 'Sign in with test number' }).click();
  await expect(
    page.getByText('This is a test version. Please use one of the test numbers.'),
  ).toBeVisible();

  await signInWithTestNumber(page, '9999900007');
  await expect(page.getByText('HAVEN · Warden')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'warden-dashboard', p);

  await signInWithTestNumber(page, '9999900009');
  await page.goto('/warden/gates');
  const move = page.getByRole('button', { name: /set gate location to my current position/i });
  await expect(move).toBeVisible({ timeout: 30_000 });
  await shot(page, 'admin-gates', p);
  // Pairing from the admin's phone: "Add device" shows the code to type on the gate.
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const codeLabel = await page
    .getByLabel(/^Pairing code /)
    .first()
    .getAttribute('aria-label');
  const pairingCode = (codeLabel ?? '').replace('Pairing code ', '').replace(/[^0-9A-Z]/gi, '');
  expect(pairingCode).toHaveLength(8);

  await signInWithTestNumber(page, '9999900005');
  await expect(page.getByText('Inside now')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'resident-home', p);

  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByText(/Test version: use a test number/)).toBeVisible({ timeout: 30_000 });
  await shot(page, 'guest-login', p);

  // The gate screen in landscape: paired with the admin's code, the QR clear of the badge.
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto(`/gate/pair?code=${pairingCode}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByText('TEST VERSION · dummy data')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await shot(page, 'gate-landscape', p);
});
