import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Fixed connection details for the single embedded-Postgres instance started once by
 * `test/global-setup.ts` for the whole `vitest` run (SDD/DEVELOPMENT.md's documented
 * integration-test level is "Vitest + Supertest against local Supabase (Docker)" —
 * this substitutes `embedded-postgres` for Docker because this sandbox has no
 * reliable Docker daemon, the same constraint recorded for the database-foundation
 * milestone; see docs/DECISIONS.md DEC-007). Shared as plain constants (not env vars)
 * so every test file — run in the same single forked worker process, see
 * `vitest.config.ts`'s `poolOptions.forks.singleFork: true` — can open its own
 * connection without any cross-process handoff.
 */
export const TEST_PG_PORT = 55439;
export const TEST_PG_USER = 'postgres';
export const TEST_PG_PASSWORD = 'postgres';
export const TEST_PG_DB = 'haven_test';
export const TEST_PG_DATA_DIR = path.join(tmpdir(), 'haven-test-embedded-pg');

export const TEST_DATABASE_URL = `postgres://${TEST_PG_USER}:${TEST_PG_PASSWORD}@127.0.0.1:${TEST_PG_PORT}/${TEST_PG_DB}`;
