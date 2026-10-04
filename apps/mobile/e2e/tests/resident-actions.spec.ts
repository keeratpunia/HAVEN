import { expect, test } from '@playwright/test';
import { generateTestGateToken } from '../gateTestToken.js';

const TEST_OTP = '123456';
const RESIDENT_EMAIL = 'e2e-host@haven.test'; // seeded in e2e-db.ts, full name "Priya Sharma"

/**
 * Resident minimal-slice specs (docs/DECISIONS.md DEC-011): create-invite, and the two
 * walk-in decisions exercised through the real FR-26 guest wait-screen polling rather
 * than asserting on the API directly, so these specs catch a regression in either
 * side of that handoff.
 */

async function signInAsGuest(page: import('@playwright/test').Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter the code')).toBeVisible();
  const digits = TEST_OTP.split('');
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`Digit ${i + 1} of 6`).fill(digits[i] ?? '');
  }
  await page.getByRole('button', { name: 'Verify' }).click();
}

async function signInAsResident(page: import('@playwright/test').Page) {
  await page.goto('/resident/login');
  await page.getByLabel('Email').fill(RESIDENT_EMAIL);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/resident\/visits$/);
}

/** Drives a guest through the walk-in flow (SDD F2) up to "Waiting for host", using a
 * fresh phone/name per call so concurrent specs don't collide on shared e2e fixtures. */
async function submitWalkIn(
  page: import('@playwright/test').Page,
  phone: string,
  guestName: string,
) {
  const token = generateTestGateToken({});
  await page.goto(`/g/${token}`);
  await page.getByRole('button', { name: 'Allow location' }).click();

  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await signInAsGuest(page, phone);

  await expect(page.getByText('About you')).toBeVisible();
  await page.getByLabel('Full name').fill(guestName);
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByRole('checkbox', { name: 'I am 18 years or older' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Take your profile photo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText('Find your host')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Room number').fill('101');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Priya Sharma' }).click();

  await expect(page.getByText('Visit type')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 30_000 });
}

test('resident creates an invite and gets a shareable link', async ({ page }) => {
  await signInAsResident(page);
  await page.goto('/resident/invite');

  await page.getByLabel('Guest name').fill('Invite Test Guest');
  await page.getByLabel('Phone number').fill('9999900005');
  await page.getByRole('button', { name: 'Day visit' }).click();
  await page.getByLabel('Date').fill('2026-10-01');
  await page.getByLabel('Start time').fill('13:00');
  await page.getByLabel('End time').fill('17:00');
  await page.getByRole('button', { name: 'Create invite' }).click();

  await expect(page.getByText('Share invite')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/\/i\//)).toBeVisible();
});

test('resident approves a walk-in and the guest wait screen turns green without reload', async ({
  page,
  browser,
}) => {
  await submitWalkIn(page, '9999900002', 'Green Screen Guest');

  const residentContext = await browser.newContext();
  const residentPage = await residentContext.newPage();
  await signInAsResident(residentPage);
  await residentPage.goto('/resident/requests');

  await residentPage
    .getByRole('button', { name: 'Approve request from Green Screen Guest' })
    .click();
  await residentContext.close();

  // No reload of `page` — this must come from FR-26's 3s poll picking up the change.
  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });
});

test('resident rejects a walk-in', async ({ page, browser }) => {
  await submitWalkIn(page, '9999900003', 'Reject Me Guest');

  const residentContext = await browser.newContext();
  const residentPage = await residentContext.newPage();
  await signInAsResident(residentPage);
  await residentPage.goto('/resident/requests');

  await residentPage.getByRole('button', { name: 'Reject request from Reject Me Guest' }).click();
  await residentContext.close();

  await expect(page.getByText("couldn't approve this visit")).toBeVisible({ timeout: 15_000 });
});
