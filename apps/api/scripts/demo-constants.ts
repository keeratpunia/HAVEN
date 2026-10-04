/**
 * Shared between demo-db.ts (writes fixtures using these) and demo-server.ts (reads
 * them). Distinct port/DB name from e2e-constants.ts so `pnpm demo` and the Playwright
 * E2E suite can both run on the same machine without colliding.
 *
 * This is a local/demo-only fixture set — same `embedded-postgres` substitute for
 * Docker as the test suites (docs/DECISIONS.md DEC-004/DEC-007/DEC-009). It only ever
 * talks to a Postgres instance it starts itself on localhost; there is no way to point
 * it at a staging or production database, which is the real enforcement behind "the
 * demo seed must never run against staging or production" — not just a convention.
 */
export const DEMO_PG_PORT = 54_625;
export const DEMO_PG_USER = 'postgres';
export const DEMO_PG_PASSWORD = 'postgres';
export const DEMO_PG_DB = 'haven_demo';
export const DEMO_DATABASE_URL = `postgres://${DEMO_PG_USER}:${DEMO_PG_PASSWORD}@127.0.0.1:${DEMO_PG_PORT}/${DEMO_PG_DB}`;

export const DEMO_API_PORT = 8080;
export const DEMO_WEB_PORT = 8081;

/** Fixed AES-256-GCM key for the demo gate secret (local-only fixture value, never real). */
export const DEMO_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
export const DEMO_JWT_SECRET = Buffer.alloc(32, 13).toString('base64');
export const DEMO_OTP_PEPPER = Buffer.alloc(32, 17).toString('base64');

export const DEMO_GATE_CODE = 'GH8DEM';
export const DEMO_GATE_SECRET = Buffer.alloc(32, 19);

/** Bangalore coordinates as a harmless default — override with real env vars on the day. */
export function demoGateLat(): number {
  return process.env.DEMO_GATE_LAT ? Number(process.env.DEMO_GATE_LAT) : 12.9716;
}
export function demoGateLng(): number {
  return process.env.DEMO_GATE_LNG ? Number(process.env.DEMO_GATE_LNG) : 77.5946;
}
/** Wider than production default (SDD §9.3's gates are ~tens of metres) — indoor GPS
 * at a presentation venue is often much less accurate; see docs/DEMO.md's GPS fallback. */
export function demoGateRadiusM(): number {
  return process.env.DEMO_GATE_RADIUS_M ? Number(process.env.DEMO_GATE_RADIUS_M) : 150;
}

export const DEMO_RESIDENT_1_EMAIL = 'priya@haven.demo';
export const DEMO_RESIDENT_1_NAME = 'Priya Sharma';
export const DEMO_RESIDENT_1_ROOM = '101';

export const DEMO_RESIDENT_2_EMAIL = 'fatima@haven.demo';
export const DEMO_RESIDENT_2_NAME = 'Fatima Khan';
export const DEMO_RESIDENT_2_ROOM = '102';

/** Non-production OTP-bypass numbers reserved by SDD §9.5 — use these to sign in as a
 * guest without a real SMS provider; +919999900001..09 are all available. */
export const DEMO_GUEST_PHONE_1 = '+919999900001';
export const DEMO_GUEST_PHONE_2 = '+919999900002';
