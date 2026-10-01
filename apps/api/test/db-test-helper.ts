import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { Database } from '../src/db/index.js';
import { TEST_DATABASE_URL } from './pg-test-constants.js';

let testDb: Kysely<Database> | undefined;

/** The one Kysely connection every integration test file shares (see global-setup.ts). */
export function getTestDb(): Kysely<Database> {
  if (!testDb) {
    testDb = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 5 }),
      }),
    });
  }
  return testDb;
}

/**
 * Wipes every row in the `haven` schema between tests (TRUNCATE doesn't fire the
 * row-level append-only triggers that block UPDATE/DELETE on `audit_log` etc., so this
 * works even for those tables). Queries `pg_tables` rather than a hand-maintained list
 * so a future migration's new table is covered automatically.
 */
export async function resetAllHavenTables(): Promise<void> {
  const db = getTestDb();
  const { rows } = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'haven'
  `.execute(db);
  if (rows.length === 0) return;
  const tableList = rows.map((row) => `haven.${row.tablename}`).join(', ');
  await sql`truncate table ${sql.raw(tableList)} restart identity cascade`.execute(db);
}

export function freshOtpPepperBase64(): string {
  return Buffer.alloc(32, 9).toString('base64');
}

export function freshJwtSecretBase64(): string {
  return Buffer.alloc(32, 5).toString('base64');
}
