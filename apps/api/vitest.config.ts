import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests (test/*.integration.test.ts) share one embedded-Postgres
    // instance started by globalSetup — singleFork keeps every test file in the same
    // process so they can share that one connection/cluster rather than each worker
    // racing to start its own on the same port.
    globalSetup: ['./test/global-setup.ts'],
    // Integration test files share one embedded-Postgres database and each resets it
    // in `beforeEach` — running files concurrently (Vitest's default) races one file's
    // TRUNCATE against another file's in-flight queries (observed as spurious FK
    // violations, deadlocks, and "no result" errors). Forcing sequential, single-worker
    // execution makes that safe.
    fileParallelism: false,
    isolate: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
