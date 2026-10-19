import { expect, test } from '@playwright/test';
import { E2E_FIXED_NOW } from '../gateTestToken.js';

/**
 * FR-08 for residents: R-15 Profile edits the name and retakes the selfie with the live
 * camera; the change is logged server side (apps/api/test/profile-edit). The guest half
 * is in account-deletion.spec.ts (G-17), which owns the last free test phone.
 */

test('FR-08: a verified resident edits their name and retakes their selfie on R-15', async ({
  page,
}) => {
  await page.clock.setFixedTime(E2E_FIXED_NOW);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('e2e-owes@haven.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/home$/, { timeout: 60_000 });
  await page.goto('/account');

  await expect(page.getByLabel('Full name')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Full name').fill('Owes Resident Renamed');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Name saved.')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Retake photo' }).click();
  await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect(page.getByText('Photo updated.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('img', { name: 'Your profile photo' })).toBeVisible();
});
