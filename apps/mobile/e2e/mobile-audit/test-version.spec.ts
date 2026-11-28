import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Phase 1 test version's own screens (DEC-028, DEC-032), at phone size. It looks like
 * the pilot: no test-version strip or hints; residents and staff sign in with a phone and
 * a code. Checks each role's header, the admin's gate tools, Back, and the gate screen in
 * landscape. Runs only against a web app built with EXPO_PUBLIC_APP_ENV=staging:
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

async function signIn(page: Page, digits: string) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Phone number').fill(digits);
  await page.getByRole('button', { name: 'Send code' }).click();
  for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1} of 6`).fill('123456'[i] ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
}

test('looks like the pilot: sign-in, role headers, admin gate tools, Back, gate screen', async ({
  page,
}, info) => {
  const p = info.project.name;
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Guest sign-in' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('TEST VERSION')).toHaveCount(0);
  await expect(page.getByText('Hostel guest check-in')).toHaveCount(0);

  // Front page → staff sign-in → Back returns to the front page.
  await page.getByRole('button', { name: 'Resident or staff sign-in' }).click();
  await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible();
  await expect(page.getByText(/99999|123456/)).toHaveCount(0);
  await shot(page, 'sign-in', p);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('button', { name: 'Guest sign-in' })).toBeVisible();

  // A real number is refused with the test-version message, on the phone step again.
  await signIn(page, '9812345678');
  await expect(
    page.getByText('This is a test version. Please use one of the test numbers.'),
  ).toBeVisible();

  await signIn(page, '9999900007');
  await expect(page.getByText('HAVEN · Warden')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'warden-dashboard', p);

  await signIn(page, '9999900009');
  await expect(page.getByText('HAVEN · Admin')).toBeVisible({ timeout: 30_000 });
  await page.goto('/warden/gates');
  await expect(
    page.getByRole('button', { name: /set gate location to my current position/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  await page.getByRole('button', { name: 'Add device' }).first().click();
  const codeLabel = await page
    .getByLabel(/^Pairing code /)
    .first()
    .getAttribute('aria-label');
  const pairingCode = (codeLabel ?? '').replace('Pairing code ', '').replace(/[^0-9A-Z]/gi, '');
  expect(pairingCode).toHaveLength(8);

  await signIn(page, '9999900005');
  await expect(page.getByText('HAVEN · Resident')).toBeVisible({ timeout: 30_000 });
  await shot(page, 'resident-home', p);

  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByText('HAVEN · Guest')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Test version/)).toHaveCount(0);
  await shot(page, 'guest-login', p);

  // The gate screen in landscape, paired with the admin's code.
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto(`/gate/pair?code=${pairingCode}`);
  await page.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByText('Guests: scan with your phone camera')).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, 'gate-landscape', p);
});
