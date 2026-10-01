import { AppError } from '../lib/errors.js';
import type { Principal } from './principal.js';

/**
 * The single, centralised authorization mechanism (CLAUDE.md §3.10, SDD §3.4): "Every
 * API handler MUST call `authorize(principal, action, resource)` ... No inline role
 * checks." This file is that mechanism, not a place to hand-write HAVEN's actual
 * permission matrix (SDD §3.3) — no feature module exists yet to have rules, so none
 * are registered here. What this provides is the *shape* every later module plugs
 * into, so the first real feature never has to invent its own ad-hoc check.
 *
 * Design: each feature module calls `definePolicy(action, rule)` once, at import
 * time, to register how it decides that action (e.g. `visits/policy.ts` would define
 * `'visits.cancel'`). `authorize()` is the single function every route handler calls;
 * it looks up the registered rule and evaluates it. An action with no registered rule
 * is **denied**, not allowed — a typo'd or not-yet-implemented action must never
 * silently pass.
 */

export type PolicyRule<TResource = unknown> = (
  principal: Principal | null,
  resource: TResource,
) => boolean;

const registry = new Map<string, PolicyRule<never>>();

/** Called by a feature module's own `policy.ts` to register how it decides one action. */
export function definePolicy<TResource>(action: string, rule: PolicyRule<TResource>): void {
  if (registry.has(action)) {
    throw new Error(`Policy for action "${action}" is already registered — define it once.`);
  }
  registry.set(action, rule as PolicyRule<never>);
}

/**
 * The function every handler calls (SDD §3.4, §8.2). Throws `AppError('FORBIDDEN',
 * 403, ...)` if the action is denied, unregistered, or the rule itself throws. Returns
 * normally (void) if allowed — callers don't branch on a return value, they just call
 * it and let the exception propagate to the central error handler.
 */
export function authorize<TResource>(
  principal: Principal | null,
  action: string,
  resource: TResource,
): void {
  const rule = registry.get(action) as PolicyRule<TResource> | undefined;
  if (!rule) {
    throw new AppError(
      'FORBIDDEN',
      403,
      'This action is not available.',
      process.env.NODE_ENV === 'production'
        ? undefined
        : { reason: `no policy registered for "${action}"` },
    );
  }

  let allowed: boolean;
  try {
    allowed = rule(principal, resource);
  } catch {
    // A rule that throws is a bug in that rule, not grounds to leak detail to the
    // caller — fail closed exactly as if it had returned false.
    allowed = false;
  }

  if (!allowed) {
    throw new AppError('FORBIDDEN', 403, "You don't have permission to do that.");
  }
}

/** Test-only: clears registered policies between test files/suites. */
export function __resetPolicyRegistryForTests(): void {
  registry.clear();
}
