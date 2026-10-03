import { expect, test } from '@playwright/test';
import { generateTestGateToken } from '../gateTestToken.js';

/**
 * Gate-flow error paths that don't require signing in first (SDD §9.1/§9.3): a scan
 * session is public, so these fail (or branch) before the app ever asks for a phone
 * number.
 */

test('expired token: scanning a stale gate QR shows "That code has changed"', async ({ page }) => {
  const expiredToken = generateTestGateToken({ stepOffset: -5 });
  await page.goto(`/g/${expiredToken}`);

  await page.getByRole('button', { name: 'Allow location' }).click();

  await expect(page.getByText('That code has changed')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText('Scan the QR on the gate screen again', { exact: false }),
  ).toBeVisible();
});

test('outside geofence: a valid token scanned far from the gate shows the location-problem screen', async ({
  page,
  context,
}) => {
  await context.setGeolocation({ latitude: 12.9716 + 1, longitude: 77.5946, accuracy: 10 });

  const token = generateTestGateToken({});
  await page.goto(`/g/${token}`);
  await page.getByRole('button', { name: 'Allow location' }).click();

  await expect(page.getByText("You're not at the gate yet")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Attempt 1 of 3')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
