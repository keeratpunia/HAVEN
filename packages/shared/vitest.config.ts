import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // SDD NFR-12: "Rules engine 100% branch coverage." packages/shared is
      // currently just the rules engine (src/rules/) plus an unused scaffold entry
      // point — the thresholds below apply package-wide for now. Revisit this config
      // when src/api/ or src/copy/ land (M1+) so the 100% branch bar stays scoped to
      // the rules engine specifically, not accidentally relaxed for the whole package.
      thresholds: {
        branches: 100,
        statements: 100,
        functions: 100,
        lines: 100,
      },
      include: ['src/rules/**/*.ts'],
      exclude: ['src/rules/**/*.test.ts'],
    },
  },
});
