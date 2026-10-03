import { expect, test } from '@playwright/test';

/**
 * Golden-path guest flow (SDD F1/F2/F3 collapsed into one run, per docs/DECISIONS.md's
 * scoping note for this milestone): invite landing -> OTP sign-in -> profile completion
 * (live camera, no gallery) -> check-in (real geolocation + live camera) -> zone notice
 * -> check-out.
 *
 * Runs against the dedicated E2E API + embedded-postgres pair (apps/api/scripts/e2e-db.ts,
 * e2e-server.ts) seeded with one fixed invite. `TEST_PHONE` is one of the non-production
 * OTP-bypass numbers (SDD §9.5): any 6-digit code request for it always accepts "123456".
 */
const TEST_PHONE = '9999900009';
const TEST_OTP = '123456';
const INVITE_TOKEN = 'e2e-fixed-invite-token-for-playwright';

test('guest can claim an invite, sign in, complete their profile, check in, and check out', async ({
  page,
}) => {
  await page.goto(`/i/${INVITE_TOKEN}`);

  await expect(page.getByText('Priya invited you to', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText("What's your phone number?")).toBeVisible();
  await page.getByLabel('Phone number').fill(TEST_PHONE);
  await page.getByRole('button', { name: 'Send code' }).click();

  await expect(page.getByText('Enter the code')).toBeVisible();
  const otpDigits = TEST_OTP.split('');
  for (let i = 0; i < otpDigits.length; i++) {
    await page.getByLabel(`Digit ${i + 1} of 6`).fill(otpDigits[i] ?? '');
  }
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByText('About you')).toBeVisible();
  await page.getByLabel('Full name').fill('Asha Guest');
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByRole('checkbox', { name: 'I am 18 years or older' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Take your profile photo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await page.waitForURL(/\/visits(\?.*)?$/);
  await page.getByText('Priya', { exact: true }).click();

  await expect(page.getByText('We need your location')).toBeVisible();
  await page.getByRole('button', { name: 'Check in' }).click();

  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Visitors' Room only")).toBeVisible();

  await page.goto('/visits');
  await page.getByText('Priya', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check out' })).toBeVisible();
  await page.getByRole('button', { name: 'Check out' }).click();

  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText("You've checked out. Thanks!")).toBeVisible({ timeout: 30_000 });
});
