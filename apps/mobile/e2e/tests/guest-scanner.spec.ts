import path from 'node:path';
import { expect, test } from '@playwright/test';
import { generateTestGateToken } from '../gateTestToken.js';

/**
 * FR-22: "The guest app also offers an in-app scanner on its home screen." The camera
 * (project `qr-camera`) shows the gate's QR; scanning it from My visits opens the gate
 * flow for that token. The guest is the walk-in guest saved by gate-retry-and-walkin.
 */
const WALK_IN_SESSION = path.join(__dirname, '..', '..', 'test-results', 'walk-in-guest.json');

test('FR-22: scanning the gate QR from My visits opens the gate flow', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: WALK_IN_SESSION,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
  });
  const page = await context.newPage();
  await page.goto('/visits');
  await page.getByRole('button', { name: 'Scan the gate QR' }).click();
  await expect(page.getByText('Point the camera at the QR on the gate screen.')).toBeVisible();

  const token = generateTestGateToken({});
  await page.waitForURL((url) => url.pathname === `/g/${token}`, { timeout: 30_000 });
  await expect(page.getByText("We can't read this code")).toHaveCount(0);
  // The refresh token rotated again: pass the session on to late-flows.spec.ts.
  await context.storageState({ path: WALK_IN_SESSION });
  await context.close();
});
