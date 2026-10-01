import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Env } from '../config.js';

/**
 * Database connection abstraction (SDD §11.7: connects as `haven_api` through
 * Supabase's pooler, port 6543, transaction mode).
 *
 * `Database` (see `./types.ts`) is hand-written, scoped to the tables actually
 * queried so far — see DEC-007 for why this isn't a `kysely-codegen` run.
 */
import type { Database } from './types.js';

export type { Database } from './types.js';

export function createDb(env: Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX'>): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/** Used by GET /ready — confirms the pooler connection actually answers a query. */
export async function pingDb(db: Kysely<Database>): Promise<boolean> {
  try {
    await db.selectNoFrom((eb) => eb.val(1).as('ok')).execute();
    return true;
  } catch {
    return false;
  }
}
