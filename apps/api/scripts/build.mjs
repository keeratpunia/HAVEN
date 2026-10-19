#!/usr/bin/env node
/**
 * Production build of the API (FINAL-QA-REPORT D-02, docs/DECISIONS.md DEC-019).
 *
 * `tsc` emitted `dist/` that imported `@haven/shared`, whose package entry is TypeScript
 * source (`main: ./src/index.ts`) — fine under tsx in dev/tests, fatal under
 * `node dist/server.js`. esbuild bundles `src/server.ts` into one ESM file with the
 * workspace package (and anything only it depends on, e.g. luxon) inlined; the API's
 * own runtime dependencies stay external and load from node_modules as usual (native
 * ones such as sharp must). Type checking stays `tsc --noEmit` (`pnpm typecheck`).
 */
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@haven/'));

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Every runtime dependency (and its subpaths, e.g. '@fastify/cookie', 'pino/file').
  external: external.flatMap((name) => [name, `${name}/*`]),
  // Bundled CommonJS (inlined deps) may call require(); give ESM output a real one.
  banner: {
    js: "import { createRequire as __havenCreateRequire } from 'node:module'; const require = __havenCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
