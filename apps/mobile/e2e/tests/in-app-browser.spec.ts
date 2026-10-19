import { expect, test } from '@playwright/test';
import { generateTestGateToken } from '../gateTestToken.js';

/**
 * E-03: "Guest opens link inside WhatsApp, Instagram or Facebook's in-app browser —
 * Detect via user agent; show 'Open in Chrome' (Android intent URL) or 'Open in Safari'
 * instructions."
 */

const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.105 Mobile Safari/537.36 Instagram 321.0.0.39.106 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_IN; 573418395)';
const FACEBOOK_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.38.108;FBBV/567890123;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';

test.describe('in Instagram on Android', () => {
  test.use({ userAgent: INSTAGRAM_ANDROID });

  test('E-03: a gate link shows "Open in Chrome"; the guest can still carry on here', async ({
    page,
  }) => {
    await page.goto(`/g/${generateTestGateToken({})}`);
    await expect(page.getByRole('heading', { name: 'Open in Chrome' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Open in Chrome' })).toBeVisible();
    // Nothing at the gate has started: no location prompt behind the notice.
    await expect(page.getByRole('button', { name: 'Allow location' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Continue here anyway' }).click();
    await expect(page.getByRole('button', { name: 'Allow location' })).toBeVisible();
  });
});

test.describe('in Facebook on iOS', () => {
  // Chromium with an iPhone user agent: only the UA matters to the detection.
  test.use({ userAgent: FACEBOOK_IOS });

  test('E-03: an invite link shows the "Open in Safari" steps', async ({ page }) => {
    await page.goto('/i/e2e-fixed-invite-token-for-playwright');
    await expect(page.getByRole('heading', { name: 'Open in Safari' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('choose Open in Safari')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open in Chrome' })).toHaveCount(0);
  });
});

test('E-03: a normal mobile browser goes straight to the gate', async ({ page }) => {
  await page.goto(`/g/${generateTestGateToken({})}`);
  await expect(page.getByRole('button', { name: 'Allow location' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'Open in Chrome' })).toHaveCount(0);
});
