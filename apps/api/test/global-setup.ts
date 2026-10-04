import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import {
  TEST_PG_DATA_DIR,
  TEST_PG_DB,
  TEST_PG_PASSWORD,
  TEST_PG_PORT,
  TEST_PG_USER,
} from './pg-test-constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

/** Every `.sql` migration, in filename order (timestamp-prefixed, so this is also chronological). */
function allMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name));
}

/**
 * Vitest `globalSetup`: starts one embedded-Postgres cluster, applies the real schema
 * migration, and leaves it running for every integration test in this run — torn down
 * by the returned function once all test files finish. `persistent: false` means the
 * data directory is wiped on `.stop()`, so every `vitest` run starts from a clean,
 * freshly-migrated database (consistent with "validate against a fresh database," the
 * standard this repo has held every DB-touching milestone to).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const pg = new EmbeddedPostgres({
    databaseDir: TEST_PG_DATA_DIR,
    port: TEST_PG_PORT,
    user: TEST_PG_USER,
    password: TEST_PG_PASSWORD,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_PG_DB);

  const client = pg.getPgClient(TEST_PG_DB);
  await client.connect();
  try {
    await client.query('create extension if not exists citext');
    await client.query('create extension if not exists pgcrypto');
    for (const file of allMigrationFiles()) {
      await client.query(readFileSync(file, 'utf-8'));
    }
  } finally {
    await client.end();
  }

  return async () => {
    await pg.stop();
  };
}
