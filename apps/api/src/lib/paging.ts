import { AppError } from './errors.js';

/**
 * SDD §12.1 pagination: `?limit=` (default 25, max 100) and `?cursor=`, responses
 * `{ items, nextCursor }`. The cursor is an opaque base64url offset — callers must
 * treat it as a token, never construct one.
 */

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError('VALIDATION_FAILED', 400, 'Invalid cursor.');
  }
  return offset;
}

/** Callers fetch `limit + 1` rows; this trims the extra and builds the next cursor. */
export function pageOf<T>(
  rows: T[],
  offset: number,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    nextCursor: hasMore ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null,
  };
}
