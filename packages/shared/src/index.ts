/**
 * @haven/shared — scaffold only.
 *
 * This package will hold (per docs/ARCHITECTURE.md §6.1 and SDD §20.1):
 *   - src/rules/   the pure rules engine (evaluateCreate/evaluateEntry/evaluateExit) — M3
 *   - src/api/     Zod request/response schemas shared by the API and the app — M1+
 *   - src/constants.ts  shared constants (gate token format, time windows, etc.) — M1+
 *   - src/copy/en.ts    error-code-to-copy mapping (SDD §13.6) — M2+
 *
 * None of that is implemented in the bootstrap milestone. This file exists only so the
 * package has a valid entry point and the workspace wiring (tsconfig, eslint, vitest,
 * `workspace:*` dependents) can be verified end to end before any business logic lands.
 */

export const HAVEN_SHARED_SCAFFOLD_VERSION = '0.0.0';
