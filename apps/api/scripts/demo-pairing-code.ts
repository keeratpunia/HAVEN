#!/usr/bin/env node
/* eslint-disable no-console -- CLI script */
/**
 * Mints a fresh 10-minute gate pairing code against an already-running demo database
 * (started by `demo-db.ts`) and prints it. The code `demo-db.ts` prints at startup
 * expires after 10 minutes (SDD F8 step 1) — if setup or rehearsal runs longer than
 * that before pairing actually happens, run this to get a new one without restarting
 * the whole demo stack.
 */
import { Client } from 'pg';
import { sha256 } from '../src/lib/crypto.js';
import { generatePairingCode, formatPairingCodeForDisplay } from '../src/lib/ids.js';
import { DEMO_DATABASE_URL, DEMO_GATE_CODE } from './demo-constants.js';

const PAIRING_CODE_TTL_MS = 10 * 60_000;

async function main() {
  const client = new Client({ connectionString: DEMO_DATABASE_URL });
  await client.connect();

  const gate = await client.query<{ id: string }>(`select id from haven.gates where code = $1`, [
    DEMO_GATE_CODE,
  ]);
  if (gate.rows.length === 0) {
    throw new Error('Demo gate not found — is demo-db.ts running?');
  }
  const gateId = gate.rows[0].id;
  const resident = await client.query<{ user_id: string }>(
    `select user_id from haven.residents where hostel_id = (select hostel_id from haven.gates where id = $1) limit 1`,
    [gateId],
  );

  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await client.query(
    `insert into haven.gate_pairing_codes (code_hash, gate_id, created_by, expires_at)
     values ($1, $2, $3, $4)`,
    [sha256(code), gateId, resident.rows[0].user_id, expiresAt.toISOString()],
  );
  await client.end();

  console.log(
    `Gate pairing code: ${formatPairingCodeForDisplay(code)} (expires ${expiresAt.toLocaleTimeString()})`,
  );
}

void main();
