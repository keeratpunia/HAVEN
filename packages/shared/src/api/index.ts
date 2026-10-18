export * from './visits.js';
export * from './residents.js';
export * from './notifications.js';
export * from './admin.js';
export * from './account.js';

/** SDD §9.12 / §12.1: POSTs marked ★ carry this header; the client generates the key
 * once per user action and reuses it on retries. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
