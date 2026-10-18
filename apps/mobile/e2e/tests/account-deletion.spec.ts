import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E_FIXED_NOW } from '../gateTestToken.js';

/**
 * "Delete my account" (FR-09, SDD §16.6) on G-17 and R-15, against the real API
 * (fixtures in apps/api/scripts/e2e-db.ts). The texts after the button label are the
 * proposed copy in docs/DECISIONS.md DEC-015.
 */

const TEST_OTP = '123456';
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close()));
});

async function residentPage(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  openContexts.push(context);
  const page = await context.newPage();
  await page.clock.setFixedTime(E2E_FIXED_NOW);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.goto('/account');
  return page;
}

async function confirmDeletion(page: Page) {
  await page.getByRole('button', { name: 'Delete my account' }).click();
  await expect(page.getByText('Delete your account?')).toBeVisible();
  await page.getByLabel('Reason (optional)').fill('Moving out');
  // The sheet's own confirm button carries the same label as the one that opened it.
  await page.getByRole('button', { name: 'Delete my account' }).last().click();
}

test('G-17: a guest deletes their account from My visits and is signed out', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Phone number').fill('9999900006');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Enter the code')).toBeVisible();
  for (let i = 0; i < 6; i++) await page.getByLabel(`Digit ${i + 1} of 6`).fill(TEST_OTP[i] ?? '');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL(/\/visits(\?.*)?$/, { timeout: 30_000 });

  await confirmDeletion(page);
  await expect(page.getByText('Deletion requested')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText("You've been signed out. Your account will be deleted within 7 days."),
  ).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('link', { name: 'My visits' })).toHaveCount(0, { timeout: 15_000 });
});

test('R-15: a resident who owes a charge is told to clear it first and stays signed in', async ({
  browser,
}) => {
  const page = await residentPage(browser, 'e2e-owes@haven.test');
  await confirmDeletion(page);
  await expect(page.getByText('Clear your charges first')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(
      "You owe ₹400. You can delete your account once the warden's office marks it paid.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible({ timeout: 30_000 });
});

test('R-15: a resident with nothing owed deletes their account and lands on sign-in', async ({
  browser,
}) => {
  const page = await residentPage(browser, 'e2e-leaving@haven.test');
  await confirmDeletion(page);
  await expect(page.getByText('Deletion requested')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'OK' }).click();
  await page.waitForURL(/\/sign-in$/, { timeout: 15_000 });
});
