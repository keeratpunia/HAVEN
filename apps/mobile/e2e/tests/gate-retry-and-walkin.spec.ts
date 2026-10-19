import path from 'node:path';
import { expect, test } from '@playwright/test';
import { generateTestGateToken } from '../gateTestToken.js';

// The walk-in test leaves its freshly signed-up guest's session here for the
// DEC-013 rescan test (all nine SDD OTP test numbers are already in use, and the
// frozen E2E clock makes the resend cooldown last the whole run).
const WALK_IN_SESSION = path.join(__dirname, '..', '..', 'test-results', 'walk-in-guest.json');

const RETRY_TEST_PHONE = '9999900008'; // pre-seeded, profile already complete, has an approved visit
const WALK_IN_TEST_PHONE = '9999900001'; // pre-seeded phone range, no existing visit at this hostel
const TEST_OTP = '123456';

async function signIn(page: import('@playwright/test').Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter the code')).toBeVisible();
  const digits = TEST_OTP.split('');
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`Digit ${i + 1} of 6`).fill(digits[i] ?? '');
  }
  await page.getByRole('button', { name: 'Verify' }).click();
}

test('GPS retry limit: 3 location failures offers "Ask host to confirm", which proceeds to awaiting_host_confirmation', async ({
  page,
  context,
}) => {
  // Sign in before scanning (the normal order — SDD F1 signs in via the invite link,
  // long before ever reaching the gate) so the scan session created below isn't
  // interrupted by a mid-flow login detour, which would discard its 3-strikes progress.
  await page.goto('/login');
  await signIn(page, RETRY_TEST_PHONE);
  await page.waitForURL(/\/visits(\?.*)?$/);

  // Outside the geofence for every attempt, including retries.
  await context.setGeolocation({ latitude: 12.9716 + 1, longitude: 77.5946, accuracy: 10 });

  const token = generateTestGateToken({});
  await page.goto(`/g/${token}`);
  await page.getByRole('button', { name: 'Allow location' }).click();

  await expect(page.getByText('Attempt 1 of 3')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Attempt 2 of 3')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Attempt 3 of 3')).toBeVisible({ timeout: 30_000 });

  const askHost = page.getByRole('button', { name: 'Ask host to confirm' });
  await expect(askHost).toBeVisible();
  await askHost.click();

  await expect(page.getByRole('button', { name: 'Check in' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Check in' }).click();

  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText('to confirm', { exact: false })).toBeVisible({ timeout: 30_000 });
});

test('walk-in: a guest with no existing visit finds a host, picks a visit type, and submits', async ({
  page,
  context,
}) => {
  const token = generateTestGateToken({});
  await page.goto(`/g/${token}`);
  await page.getByRole('button', { name: 'Allow location' }).click();

  await expect(page.getByText("What's your phone number?")).toBeVisible({ timeout: 30_000 });
  await signIn(page, WALK_IN_TEST_PHONE);

  await expect(page.getByText('About you')).toBeVisible();
  await page.getByLabel('Full name').fill('Walk In Guest');
  await page.getByRole('radio', { name: 'Female' }).click();
  await page.getByRole('checkbox', { name: 'I am 18 years or older' }).click();
  await page.getByRole('checkbox', { name: 'I agree to the privacy notice' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Take your profile photo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText('Find your host')).toBeVisible({ timeout: 30_000 });
  // Back from sign-up, marked as resumed (DEC-013).
  expect(page.url()).toContain('resumed=1');
  await page.getByLabel('Room number').fill('101');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Select Priya S.' }).click();

  await expect(page.getByText('Visit type')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  // Shift onto a different fake-camera frame than the profile selfie (see PHOTO_REUSED
  // note in resident-app.spec.ts's takeLivePhoto).
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();

  await expect(page.getByText('Waiting for host')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("We've notified your host.")).toBeVisible();
  await context.storageState({ path: WALK_IN_SESSION });
});

test('DEC-013: a guest back from sign-up on an expired code is told to scan once more, not "That code has changed"', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: WALK_IN_SESSION,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
  });
  const page = await context.newPage();
  // A code that has really expired on the server (6 steps = 60 s old).
  // (The saved session includes the "location explainer seen" flag, so there's no
  // Allow-location step this time — as for any returning guest.)
  await page.goto(`/g/${generateTestGateToken({ stepOffset: -6 })}?resumed=1`);

  await expect(page.getByText("You're signed in")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText('Scan the QR on the gate screen once more to continue. Your details are saved.'),
  ).toBeVisible();
  await expect(page.getByText('That code has changed')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to My visits' }).click();
  await page.waitForURL(/\/visits/);
  await context.close();
});
