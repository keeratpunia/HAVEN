import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** FR-22: a Y4M of the gate QR (written by global-setup.ts) used as the camera. */
export const GATE_QR_VIDEO = path.join(__dirname, '..', 'test-results', 'gate-qr.y4m');

/**
 * SDD §19.1: "End-to-end (web): Playwright, mobile viewport, fake geolocation and fake
 * camera (`--use-fake-device-for-media-stream`). Guest flows F1, F2, F3, F5; gate page."
 *
 * Geolocation here matches `E2E_GATE_LAT`/`E2E_GATE_LNG` in
 * apps/api/scripts/e2e-constants.ts, so the real haversine-distance geofence check in
 * `apps/api/src/gate/geofence.ts` genuinely passes during the test. `accuracy: 10`
 * ensures the client's own `captureScanLocation` (SDD §9.3: "stop when accuracy <=
 * 20m") resolves immediately rather than waiting out its 10s timeout.
 *
 * Timeouts are generous: this sandbox's Chromium takes roughly a minute to fetch the
 * unminified Expo web dev bundle over loopback (confirmed via `curl`, which gets the
 * same bundle in ~5s) — not a hang, just this specific environment being slow to
 * compile/serve it.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:8081',
    viewport: { width: 360, height: 640 },
    actionTimeout: 20_000,
    navigationTimeout: 90_000,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 10 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /guest-scanner\.spec\.ts/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 640 },
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    {
      // FR-22: the camera shows the gate QR. Runs after `chromium`, whose walk-in test
      // saves the signed-in guest this one reuses (every test phone is taken).
      name: 'qr-camera',
      testMatch: /guest-scanner\.spec\.ts/,
      dependencies: ['chromium'],
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 640 },
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${GATE_QR_VIDEO}`,
          ],
        },
      },
    },
  ],
});
