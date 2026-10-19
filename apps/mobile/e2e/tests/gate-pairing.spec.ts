import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FIXED_NOW } from '../gateTestToken.js';

/**
 * F8 steps 1-3 (FR-56, D-01, D-02): the warden adds a device on W-09, a phone opens
 * /gate, enters the 8-character code, and becomes a gate screen showing the rotating QR
 * and no personal data. E-14: a gate whose location was never set (the seeded "Back
 * gate") puts the red banner on W-01. No device is revoked here: that would rotate the
 * gate secret every other spec's QR tokens are generated from.
 */

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()));
});

async function wardenPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  openContexts.push(context);
  const page = await context.newPage();
  await page.clock.setFixedTime(E2E_FIXED_NOW);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('e2e-warden@haven.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/warden$/, { timeout: 60_000 });
  return page;
}

test('E-14: a gate without a location shows the red banner on the warden dashboard', async ({
  browser,
}) => {
  const warden = await wardenPage(browser);
  await expect(
    warden.getByText("Set the gate location — Back gate can't check anyone in yet."),
  ).toBeVisible({ timeout: 30_000 });
});

test('F8: the warden adds a device; a phone pairs with the code and shows the gate QR', async ({
  browser,
}) => {
  const warden = await wardenPage(browser);
  await warden.goto('/warden/gates');
  await warden.getByRole('button', { name: 'Add device' }).first().click();
  const pairing = warden.getByLabel(/^Pairing code /);
  await expect(pairing).toBeVisible({ timeout: 15_000 });
  const code = ((await pairing.getAttribute('aria-label')) ?? '')
    .replace('Pairing code ', '')
    .replace(/[^0-9A-Z]/g, '');
  expect(code).toMatch(/^[0-9A-Z]{8}$/);

  const deviceContext = await browser.newContext();
  openContexts.push(deviceContext);
  const device = await deviceContext.newPage();
  await device.clock.setFixedTime(E2E_FIXED_NOW);
  await device.goto('/gate');
  await device.waitForURL(/\/gate\/pair$/, { timeout: 60_000 });
  await device.getByLabel('Pairing code').fill(code);
  await device.getByRole('button', { name: 'Pair' }).click();

  await expect(
    device.getByText('Guests: scan with your phone camera to enter or leave'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(device.getByText('Main gate')).toBeVisible();
  await expect(device.locator('canvas')).toBeVisible();
  // D-02 shows no personal data, ever.
  await expect(device.getByText(/\+91\d{10}/)).toHaveCount(0);
  await expect(device.getByText(/Tester|Priya/)).toHaveCount(0);

  // W-09 now lists the device.
  await warden.reload();
  await expect(warden.getByRole('button', { name: /^Remove / }).first()).toBeVisible({
    timeout: 30_000,
  });
});
