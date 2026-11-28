import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FIXED_NOW, generateTestGateToken } from '../gateTestToken.js';

/**
 * Warden and office (SDD §13.4 W-01..W-12, O-01) on the web target against the real API
 * and database (fixtures in apps/api/scripts/e2e-db.ts). Staff sign in with the DEC-011
 * dev sign-in (no Google OAuth credentials exist in this environment).
 */

const TEST_OTP = '123456';
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()));
});

async function staffPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  openContexts.push(context);
  const page = await context.newPage();
  await page.clock.setFixedTime(E2E_FIXED_NOW);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

async function guestSignIn(page: Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter the code')).toBeVisible();
  for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1} of 6`).fill(TEST_OTP[i] ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
}

async function takePhoto(page: Page, settleMs = 0) {
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  if (settleMs) await page.waitForTimeout(settleMs);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();
}

test('FR-05: the warden verifies a resident; the ID card photo is gone afterwards', async ({
  browser,
}) => {
  const warden = await staffPage(browser, 'e2e-warden@haven.test');
  await warden.waitForURL(/\/warden$/, { timeout: 60_000 });
  await expect(warden.getByRole('button', { name: /^Pending residents: \d+$/ })).toBeVisible();
  await warden.getByRole('button', { name: /^Pending residents/ }).click();
  await warden.waitForURL(/\/warden\/approvals/);

  await expect(warden.getByText('Kiran Pending')).toBeVisible();
  await expect(warden.getByLabel('ID card of Kiran Pending')).toBeVisible();
  await expect(warden.getByText('Room 102', { exact: false })).toBeVisible();
  await warden.getByRole('button', { name: 'Verify Kiran Pending' }).click();
  await expect(
    warden.getByText('Kiran Pending is verified. The ID card photo was deleted.'),
  ).toBeVisible();
  // Other specs may leave their own pending residents, so check this one only.
  await expect(warden.getByRole('button', { name: 'Verify Kiran Pending' })).toHaveCount(0);

  await warden.goto('/warden/residents');
  await expect(
    warden.getByRole('button', { name: /^Kiran Pending, room 102, verified$/ }),
  ).toBeVisible({ timeout: 15_000 });
});

test('FR-15/FR-59: the warden approves an overnight request, the office sees the charge and marks it paid', async ({
  browser,
}) => {
  const warden = await staffPage(browser, 'e2e-warden@haven.test');
  await warden.waitForURL(/\/warden$/, { timeout: 60_000 });
  await warden.goto('/warden/approvals');
  await expect(warden.getByText('Overnight Cousin · Overnight in my room')).toBeVisible({
    timeout: 15_000,
  });
  // This request's card (other specs add their own requests to the same list).
  const cousinCard = warden
    .locator('div')
    .filter({ hasText: 'Overnight Cousin · Overnight in my room' })
    .filter({ hasText: /2 night\(s\) · ₹100/ })
    .filter({ hasNotText: 'Overnight Guest' });
  await expect(cousinCard.last()).toBeVisible();
  await warden.getByRole('button', { name: 'Approve request for Overnight Cousin' }).click();
  await expect(
    warden.getByText("Approved Overnight Cousin's stay. The charge is pending."),
  ).toBeVisible();

  const office = await staffPage(browser, 'e2e-office@haven.test');
  await office.waitForURL(/\/office\/charges$/, { timeout: 60_000 });
  await expect(office.getByText('₹100 · Overnight in room')).toBeVisible({ timeout: 15_000 });
  await expect(office.getByText(/Priya Sharma · room 101/)).toBeVisible();
  // TC-SEC-03 through the UI: no guest phone anywhere on the office screen.
  expect(await office.locator('body').innerText()).not.toMatch(/\+91|98123/);

  await office.getByLabel('Receipt number').fill('GH8-0007');
  await office.getByRole('button', { name: 'Mark charge for Priya Sharma paid' }).click();
  await expect(office.getByText('Marked paid.')).toBeVisible();
  await office.getByRole('tab', { name: 'Paid' }).click();
  await expect(office.getByText('Receipt GH8-0007')).toBeVisible({ timeout: 15_000 });
});

test('FR-50/§9.9: a check-in appears on the warden’s Inside list without a reload', async ({
  page,
  browser,
}) => {
  const warden = await staffPage(browser, 'e2e-warden@haven.test');
  await warden.waitForURL(/\/warden$/, { timeout: 60_000 });
  await warden.getByRole('tab', { name: 'Inside' }).click();
  await expect(warden.getByText('● Live')).toBeVisible({ timeout: 20_000 });
  await expect(warden.getByRole('button', { name: /^Live Tester,/ })).toHaveCount(0);

  // The guest checks in at the gate (F1).
  await page.goto(`/g/${generateTestGateToken({})}`);
  await page.getByRole('button', { name: 'Allow location' }).click();
  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await guestSignIn(page, '9999900004');
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Check in' }).click();
  await takePhoto(page);
  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 30_000 });

  // Arrives over the stream well inside the 15 s polling fallback.
  await expect(
    warden.getByRole('button', { name: /^Live Tester, guest of Priya S\./ }),
  ).toBeVisible({ timeout: 8_000 });
});

test('FR-53/FR-54, E-12: the warden force-checks-out and bans a guest, who is then refused at the gate', async ({
  page,
  browser,
}) => {
  const warden = await staffPage(browser, 'e2e-warden@haven.test');
  await warden.waitForURL(/\/warden$/, { timeout: 60_000 });
  await warden.getByRole('tab', { name: 'Inside' }).click();
  await warden.getByRole('button', { name: /^Ban Tester, guest of Priya S\./ }).click();
  await warden.waitForURL(/\/warden\/visits\/[0-9a-f-]{36}$/);
  await expect(warden.getByText('+919999900005')).toBeVisible(); // the warden sees the phone (§3.3)

  await warden.getByRole('button', { name: 'Force check-out' }).click();
  await warden.getByLabel('Reason (required)').fill('Not who the host expected');
  await warden.getByRole('button', { name: 'Force check-out' }).last().click();
  await expect(warden.getByText('The warden checked the guest out.')).toBeVisible({
    timeout: 15_000,
  });

  await warden.getByRole('button', { name: 'Ban guest' }).click();
  await warden.getByRole('textbox', { name: 'Reason', exact: true }).fill('Unknown to the host');
  await warden.getByRole('button', { name: 'Confirm ban' }).click();
  await expect(warden.getByText('Guest banned.')).toBeVisible();
  await warden.goto('/warden/bans');
  await expect(warden.getByText('Ban Tester')).toBeVisible({ timeout: 15_000 });

  // The banned guest scans the gate and asks to come in again: refused (BR-09).
  await page.goto(`/g/${generateTestGateToken({})}`);
  await page.getByRole('button', { name: 'Allow location' }).click();
  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await guestSignIn(page, '9999900005');
  await expect(page.getByText('Find your host')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Room number').fill('101');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Priya S.' }).click();
  await expect(page.getByText('Visit type')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await takePhoto(page);
  await expect(page.getByText("You can't enter this hostel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Please contact the warden's office.")).toBeVisible();
});
