import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FIXED_NOW, generateTestGateToken } from '../gateTestToken.js';

/**
 * Resident app (SDD §13.4 R-01..R-15) on the web target, against the real API and
 * database (`e2e-server.ts`, clock frozen at E2E_FIXED_NOW = Thu 1 Oct 2026, 12:00 IST).
 * Resident pages freeze the browser clock to the same instant so the forms' shared
 * rules hints agree with the server. Sign-in uses the DEC-011 dev bypass (no Google
 * OAuth credentials exist in this environment).
 */

const TEST_OTP = '123456';
const HOST_EMAIL = 'e2e-host@haven.test'; // Priya Sharma, room 101 (e2e-db.ts)
const NEWCOMER_EMAIL = 'e2e-newcomer@haven.test';

// Resident shells poll Home and notifications every 10 s; contexts left open across tests
// add up to the API's global 120 requests/min per IP (SDD §12.11) and the later tests
// start getting 429s. Every context a test opens is closed when it ends.
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()));
});

async function residentPage(browser: Browser, email = HOST_EMAIL): Promise<Page> {
  const context = await browser.newContext();
  openContexts.push(context);
  const page = await context.newPage();
  await page.clock.setFixedTime(E2E_FIXED_NOW);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return page;
}

async function enterOtp(page: Page) {
  const digits = TEST_OTP.split('');
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`Digit ${i + 1} of 6`).fill(digits[i] ?? '');
  }
  await page.getByRole('button', { name: 'Verify' }).click();
}

async function guestSignIn(page: Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter the code')).toBeVisible();
  await enterOtp(page);
}

/**
 * Chrome's fake camera restarts its test animation on every new stream, so two captures
 * taken at the same moment after the shutter enables are byte-identical — and the
 * server rightly rejects the second as PHOTO_REUSED. `settleMs` shifts a later capture
 * onto a different frame. (A real camera never produces identical frames.)
 */
async function takeLivePhoto(page: Page, settleMs = 0) {
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();
}

/** A new guest walks in (SDD F2) and ends on the waiting screen (G-11). */
async function submitWalkIn(page: Page, phone: string, guestName: string) {
  await page.goto(`/g/${generateTestGateToken({})}`);
  await page.getByRole('button', { name: 'Allow location' }).click();
  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await guestSignIn(page, phone);
  await expect(page.getByText('About you')).toBeVisible();
  await page.getByLabel('Full name').fill(guestName);
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByRole('checkbox', { name: 'I am 18 years or older' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Take your profile photo')).toBeVisible();
  await takeLivePhoto(page);
  await expect(page.getByText('Find your host')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Room number').fill('101');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Priya S.' }).click();
  await expect(page.getByText('Visit type')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await takeLivePhoto(page, 1_500);
  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 30_000 });
}

test('R-01 → R-02 → R-03 → R-04: a new resident verifies their phone, onboards and waits', async ({
  browser,
}) => {
  const page = await residentPage(browser, NEWCOMER_EMAIL);
  await page.waitForURL(/\/phone$/, { timeout: 60_000 });
  await page.getByLabel('Phone number').fill('9999900006');
  await page.getByRole('button', { name: 'Send code' }).click();
  await enterOtp(page);

  await page.waitForURL(/\/onboarding$/);
  await expect(page.getByRole('radio', { name: 'GH-8 Florence Nightingale' })).toBeChecked();
  await page.getByLabel('Room number').fill('205');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Photo of your hostel ID card')).toBeVisible();
  await takeLivePhoto(page);
  await expect(page.getByText('Take a selfie')).toBeVisible({ timeout: 30_000 });
  await takeLivePhoto(page);

  await expect(page.getByRole('button', { name: 'Submit for verification' })).toBeDisabled({
    timeout: 30_000,
  });
  await page
    .getByRole('checkbox', { name: 'I agree to share these details with the warden' })
    .click();
  await page.getByRole('button', { name: 'Submit for verification' }).click();

  await page.waitForURL(/\/pending$/);
  await expect(page.getByText('Waiting for the warden to verify you')).toBeVisible();
  await expect(page.getByText('Room 205')).toBeVisible();
});

test('resident creates an invite and gets a shareable link (R-06 → R-07)', async ({ browser }) => {
  const page = await residentPage(browser);
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Invite' }).click();

  await page.getByLabel('Guest name').fill('Invite Test Guest');
  await page.getByLabel('Phone number').fill('9999900005');
  await page.getByLabel('Date').fill('2026-10-01');
  await page.getByLabel('Start').fill('13:00');
  await page.getByLabel('End').fill('17:00');
  const create = page.getByRole('button', { name: 'Create invite' });
  // Enabled only once the server preview agrees (SDD §14: disabled until valid).
  await expect(create).toBeEnabled({ timeout: 15_000 });
  await create.click();

  await expect(page.getByText('Share invite')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(
      "Hi Invite Test Guest, I've added you as my guest at Florence Nightingale on Thu, 1 Oct, 1:00 pm–5:00 pm.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByLabel(/^Invite link .*\/i\/[A-Za-z0-9_-]{22}$/)).toBeVisible();
});

test('R-06 refuses a window after 10 pm from the shared rules, before asking the server', async ({
  browser,
}) => {
  const page = await residentPage(browser);
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.goto('/invite');
  await page.getByLabel('Guest name').fill('Late Guest');
  await page.getByLabel('Phone number').fill('9999900005');
  await page.getByLabel('Date').fill('2026-10-01');
  await page.getByLabel('Start').fill('21:00');
  await page.getByLabel('End').fill('23:00');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Pick a time between 8:00 am and 10:00 pm' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invite' })).toBeDisabled();
});

test('a walk-in notification opens R-08; approving turns the guest screen green without reload', async ({
  page,
  browser,
}) => {
  const host = await residentPage(browser);
  await host.waitForURL(/\/home$/, { timeout: 60_000 });
  await expect(host.getByText('Inside now')).toBeVisible({ timeout: 30_000 });

  await submitWalkIn(page, '9999900002', 'Green Screen Guest');

  // The web stand-in for push: the shell's in-app banner, routed by the payload's screen.
  const banner = host.getByRole('button', {
    name: /Guest at the gate Green Screen Guest wants to visit you/,
  });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await banner.click();
  await host.waitForURL(/\/walk-in\/[0-9a-f-]{36}$/);
  await expect(host.getByText('Guest at the gate')).toBeVisible();
  await expect(host.getByText('✓ Location verified')).toBeVisible();
  await host.getByRole('button', { name: 'Approve' }).click();
  await expect(host.getByText('Approved — your guest is checked in')).toBeVisible({
    timeout: 15_000,
  });

  // No reload of the guest page — FR-26's 3 s poll picks the change up.
  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 15_000 });
});

test('resident rejects a walk-in from Home; the guest sees "couldn’t approve"', async ({
  page,
  browser,
}) => {
  await submitWalkIn(page, '9999900003', 'Reject Me Guest');

  const host = await residentPage(browser);
  await host.waitForURL(/\/home$/, { timeout: 60_000 });
  await expect(host.getByText('⏱ Waiting for you')).toBeVisible({ timeout: 30_000 });
  await host.getByRole('button', { name: /^Reject Me Guest, Day visit/ }).click();
  await host.waitForURL(/\/walk-in\//);
  await host.getByRole('button', { name: 'Reject', exact: true }).click();
  await host.getByLabel('Reason (optional)').fill('Not today');
  await host.getByRole('button', { name: 'Reject request' }).click();
  await expect(host.getByText('✕ Not allowed')).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText("couldn't approve this visit")).toBeVisible({ timeout: 15_000 });
});

test('N-ARRIVED in Notifications opens R-09; "Not my guest" reports the arrival', async ({
  page,
  browser,
}) => {
  // The pre-claimed guest scans the gate and signs in inside the gate flow (F1 steps
  // 6-10); the E2E server's frozen clock keeps the token valid through the sign-in.
  await page.goto(`/g/${generateTestGateToken({})}`);
  await page.getByRole('button', { name: 'Allow location' }).click();
  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await guestSignIn(page, '9999900007');
  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Check in' }).click();
  await takeLivePhoto(page);
  await expect(page.getByText("You're checked in")).toBeVisible({ timeout: 30_000 });

  const host = await residentPage(browser);
  await host.waitForURL(/\/home$/, { timeout: 60_000 });
  await host.goto('/notifications');
  await host.getByRole('button', { name: /Unread\. Arrival Tester has arrived/ }).click();
  await host.waitForURL(/\/arrival\/[0-9a-f-]{36}$/);
  await expect(host.getByText('Checked in at 12:00 pm', { exact: true })).toBeVisible();
  await expect(host.getByLabel('Live photo of Arrival Tester at the gate')).toBeVisible();

  await host.getByRole('button', { name: 'Not my guest' }).click();
  await host.getByRole('button', { name: 'Report guest' }).click();
  await expect(host.getByText('You reported this guest', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(host.getByText('✕ You reported this guest as not yours.')).toBeVisible();
  await expect(host.getByRole('button', { name: 'Not my guest' })).toHaveCount(0);
});

test('R-11 previews nights, charge and quota, then sends the request to the warden', async ({
  browser,
}) => {
  const page = await residentPage(browser);
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Overnight' }).click();

  await page.getByLabel('Guest name').fill('Overnight Guest');
  await page.getByLabel('Phone number').fill('9999900004');
  await page.getByRole('tab', { name: 'Female' }).click();
  await page.getByRole('tab', { name: 'Overnight in my room' }).click();
  await page.getByRole('textbox', { name: 'Arrival', exact: true }).fill('2026-10-02');
  await page.getByRole('textbox', { name: 'Departure', exact: true }).fill('2026-10-04');

  await expect(page.getByText('2 nights · ₹100')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('October: 2 of 3 nights after this')).toBeVisible();
  await page.getByRole('button', { name: 'Send to warden' }).click();
  await expect(page.getByText('Sent to the warden')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Open the request' }).click();
  await expect(page.getByText('Waiting for warden')).toBeVisible({ timeout: 15_000 });
});

test('a visit the resident does not host is "not available" (TC-SEC-01 through the UI)', async ({
  browser,
}) => {
  const page = await residentPage(browser);
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.goto('/visit/00000000-0000-4000-8000-000000000000');
  await expect(page.getByText("This visit isn't available.")).toBeVisible({ timeout: 30_000 });
});
