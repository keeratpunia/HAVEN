import Home from '../app/index.js';
import RootLayout from '../app/_layout.js';

/**
 * Infra smoke test: proves the Expo Router entry files compile (TSX + Metro/Babel
 * transform) and export valid React components under jest-expo.
 *
 * Lives outside `app/` deliberately — Expo Router treats every file under `app/` as a
 * potential route (SDD §13.3), including `.test.tsx` files, and will try to render
 * this file's `describe`/`it` calls as a screen at runtime (a real bug this move
 * fixes: the guest web app crashed with "describe is not defined" until this file was
 * relocated — found while getting the Playwright E2E suite running for the first
 * time, see docs/DECISIONS.md).
 */
describe('bootstrap route modules', () => {
  it('export React components', () => {
    expect(typeof Home).toBe('function');
    expect(typeof RootLayout).toBe('function');
  });
});
