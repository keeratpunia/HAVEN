import { describe, expect, it } from 'vitest';
import { createDb, pingDb } from './index.js';

describe('pingDb', () => {
  it('returns false (not a throw) when the database is unreachable', async () => {
    // Port 1 is a reserved/unassigned port — nothing listens there, so this connects
    // and fails fast (ECONNREFUSED) without needing a real Postgres instance.
    const db = createDb({
      DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/postgres',
      DB_POOL_MAX: 1,
    });
    const ok = await pingDb(db);
    expect(ok).toBe(false);
    await db.destroy();
  });
});
