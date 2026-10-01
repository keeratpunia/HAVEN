import BootPlaceholder from './index';
import RootLayout from './_layout';

/**
 * Infra smoke test: proves the Expo Router entry files compile (TSX + Metro/Babel
 * transform) and export valid React components under jest-expo. Not a product-screen
 * test — there is no product screen yet.
 */
describe('bootstrap route modules', () => {
  it('export React components', () => {
    expect(typeof BootPlaceholder).toBe('function');
    expect(typeof RootLayout).toBe('function');
  });
});
