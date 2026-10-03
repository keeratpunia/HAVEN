/** Shared between e2e-db.ts (writes fixtures using these) and e2e-server.ts (reads them). */
export const E2E_PG_PORT = 54_621;
export const E2E_PG_USER = 'postgres';
export const E2E_PG_PASSWORD = 'postgres';
export const E2E_PG_DB = 'haven_e2e';
export const E2E_DATABASE_URL = `postgres://${E2E_PG_USER}:${E2E_PG_PASSWORD}@127.0.0.1:${E2E_PG_PORT}/${E2E_PG_DB}`;

/** Frozen "now" the e2e API server's clock also uses — noon IST, safely inside visiting hours. */
export const E2E_FIXED_NOW = new Date('2026-10-01T06:30:00.000Z');
export const E2E_INVITE_TOKEN = 'e2e-fixed-invite-token-for-playwright';
/** Matches Playwright's `geolocation` context option in playwright.config.ts. */
export const E2E_GATE_LAT = 12.9716;
export const E2E_GATE_LNG = 77.5946;
export const E2E_GATE_RADIUS_M = 200;
