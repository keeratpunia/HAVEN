#!/usr/bin/env node
/**
 * Prints fresh random values for every secret the API needs (SDD §20.3, §16.4). Run it
 * yourself, in your own terminal, when you set up a deployment — never paste the output
 * into chat, an issue, a commit or a screenshot. Each deployment (the Phase 1 test
 * version, the Phase 2 pilot) gets its own set: never reuse one between them.
 *
 *   node scripts/generate-secrets.mjs
 *
 * Where each value goes is in docs/DEPLOY-TEST.md.
 */
import { randomBytes, randomInt } from 'node:crypto';

const base64 = (n) => randomBytes(n).toString('base64');

/** Letters and digits only, so it can sit inside a postgres:// URL without escaping. */
function urlSafePassword(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

const values = [
  ['JWT_SECRET', base64(32), 'Render'],
  ['OTP_PEPPER', base64(32), 'Render'],
  ['DATA_ENCRYPTION_KEY', base64(32), 'Render AND apps/api/.env.staging.local (must match)'],
  [
    'HAVEN_API_DB_PASSWORD',
    urlSafePassword(32),
    'apps/api/.env.staging.local, and inside the DATABASE_URL / DATABASE_DIRECT_URL on Render',
  ],
];

console.log(
  '\nFresh secrets — copy each one straight into where it goes, then close this window.\n',
);
for (const [name, value, where] of values) {
  console.log(`${name}=${value}`);
  console.log(`    → ${where}\n`);
}
