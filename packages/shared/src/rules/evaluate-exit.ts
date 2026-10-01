import type { RulesConfig } from './config.js';
import type { ExitContext, RuleCode, RuleResult } from './types.js';
import { RuleResultBuilders } from './types.js';

const { flaggedResult } = RuleResultBuilders;

/**
 * SDD §4.4/§4.5: `evaluateExit` — never denies (BR-17: "Check-out is never refused
 * for rule reasons. Failed GPS on exit is allowed but flagged."). Only ever returns
 * 'allow' or 'allow_flagged'.
 */
export function evaluateExit(ctx: ExitContext, cfg: RulesConfig): RuleResult {
  const flags: RuleCode[] = [];

  if (!ctx.gpsOk) {
    flags.push('LOCATION_UNVERIFIED');
  }

  // BR-13: overstaying once past window_end + overstay_grace_minutes.
  const lateThreshold = new Date(ctx.windowEnd.getTime() + cfg.overstay_grace_minutes * 60_000);
  if (ctx.now >= lateThreshold) {
    flags.push('LATE_EXIT');
  }

  return flaggedResult(flags);
}
