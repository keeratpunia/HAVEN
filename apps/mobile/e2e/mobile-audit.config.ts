import { defineConfig, devices } from '@playwright/test';

/**
 * Phone-layout audit (DEC-026 Phase 1, "mobile-first pass"). Not part of the CI suite:
 * it runs against a running `pnpm demo` (seeded data, dev sign-in) and visits every
 * route of every role at the two target phone sizes, saving screenshots and a list of
 * layout problems (horizontal overflow, tap targets under 44 px).
 *
 *   pnpm demo                                  # in one terminal
 *   pnpm --filter @haven/mobile run audit:mobile
 *
 * Both projects run Chromium. The "iphone" project uses the iPhone's size, pixel ratio
 * and touch, but it is not Safari: real-iPhone checks are in docs/PHONE-TEST-CHECKLIST.md.
 */
export default defineConfig({
  testDir: './mobile-audit',
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.AUDIT_WEB_URL ?? 'http://localhost:8081',
    actionTimeout: 20_000,
    navigationTimeout: 120_000,
    permissions: ['geolocation', 'camera'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
  },
  projects: [
    {
      name: 'android-360',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 800 },
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    {
      name: 'iphone-390',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
});
