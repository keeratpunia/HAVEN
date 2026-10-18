import { useCallback, useRef } from 'react';

/** A UUID v4 for `Idempotency-Key` (SDD §9.12). */
export function newActionKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * "The client generates the key once per user action and reuses it on retries" (SDD
 * §9.12): `keyFor('approve')` returns the same key until `done('approve')` is called
 * after a success, so a retry after a network drop replays instead of acting twice.
 */
export function useActionKeys() {
  const keys = useRef(new Map<string, string>());
  const keyFor = useCallback((action: string) => {
    let key = keys.current.get(action);
    if (!key) {
      key = newActionKey();
      keys.current.set(action, key);
    }
    return key;
  }, []);
  const done = useCallback((action: string) => {
    keys.current.delete(action);
  }, []);
  return { keyFor, done };
}
