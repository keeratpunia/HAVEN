/**
 * @haven/shared
 *
 * Holds (per docs/ARCHITECTURE.md §6.1 and SDD §20.1):
 *   - src/rules/   the pure rules engine (evaluateCreate/evaluateEntry/evaluateExit) — done
 *   - src/api/     Zod request/response schemas shared by the API and the app — M1+
 *   - src/constants.ts  shared constants (gate token format, time windows, etc.) — M1+
 *   - src/copy/en.ts    error-code-to-copy mapping (SDD §13.6) — M2+
 */

export const HAVEN_SHARED_SCAFFOLD_VERSION = '0.0.0';

export * from './rules/index.js';
export * from './copy/en.js';
export * from './api/index.js';
export * from './format.js';
