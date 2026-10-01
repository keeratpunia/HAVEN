/**
 * Response serialization pattern (SDD §8.2: "repository (Kysely) → serializer (strips
 * fields by role) → response"; SDD §3.4: "Office endpoints MUST strip visitor.phone
 * and all photo URLs from responses (enforced in the serializer, tested in
 * TC-SEC-03)"). No real serializer exists yet — there is no DTO to shape until a
 * feature module has a database row to turn into one — this is the reusable pattern
 * every later `serializer.ts` follows, so role-based field stripping is never
 * reimplemented ad hoc per endpoint.
 *
 * Convention: a feature module exports a function `(row, principal) => Dto` that
 * calls `omitFields` for whichever fields that principal's role shouldn't see, rather
 * than building several near-duplicate response shapes by hand.
 */

/** Returns a shallow copy of `obj` with the named keys removed. Never mutates `obj`. */
export function omitFields<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

/**
 * A serializer is a plain function from (row, principal) to a response DTO. Typed
 * here so every feature module's serializer has the same shape; there is nothing to
 * register or look up (unlike `authorize()`) because serializers are called directly
 * by the handler that already knows which one it needs.
 */
export type Serializer<TRow, TPrincipal, TDto> = (row: TRow, principal: TPrincipal) => TDto;
