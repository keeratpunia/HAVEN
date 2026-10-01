import type { RulesConfig } from './config.js';
import { isLocalTimeAtOrAfter } from './time.js';
import type { EntryContext, RuleCode, RuleResult } from './types.js';
import { RuleResultBuilders } from './types.js';

const { denyResult, flaggedResult } = RuleResultBuilders;

/**
 * SDD §4.4/§4.5: `evaluateEntry` — gate check-in, host-assisted entry. Steps 1-8 deny
 * and return immediately; steps 9-10 are flags that accumulate (an approved visit is
 * never retroactively refused for crowding or a prior host-confirmed location — those
 * are surfaced to the warden, not blocked).
 */
export function evaluateEntry(ctx: EntryContext, cfg: RulesConfig): RuleResult {
  // 1. VISITOR_BANNED
  if (ctx.visitorBanned) {
    return denyResult('VISITOR_BANNED');
  }

  // 2. HOST_NOT_VERIFIED / HOST_SUSPENDED
  if (ctx.host.status !== 'verified') {
    return denyResult('HOST_NOT_VERIFIED');
  }
  if (ctx.host.suspendedUntil !== null && ctx.host.suspendedUntil > ctx.now) {
    return denyResult('HOST_SUSPENDED');
  }

  // 3. VISIT_NOT_APPROVED
  if (ctx.visitStatus !== 'approved') {
    return denyResult('VISIT_NOT_APPROVED');
  }

  // 4. AFTER_HARD_CUTOFF — applies to every visit type
  if (isLocalTimeAtOrAfter(ctx.now, cfg.hard_cutoff, cfg.timezone)) {
    return denyResult('AFTER_HARD_CUTOFF');
  }

  // 5. AFTER_ENTRY_CUTOFF — day/quick_drop only
  const isDayType = ctx.type === 'day' || ctx.type === 'quick_drop';
  if (isDayType && isLocalTimeAtOrAfter(ctx.now, cfg.last_entry_day, cfg.timezone)) {
    return denyResult('AFTER_ENTRY_CUTOFF');
  }

  // 6. TOO_EARLY — BR-20: up to early_arrival_minutes before window_start is fine
  const earliestAllowed = new Date(ctx.windowStart.getTime() - cfg.early_arrival_minutes * 60_000);
  if (ctx.now < earliestAllowed) {
    return denyResult('TOO_EARLY');
  }

  // 7. WINDOW_ENDED
  if (ctx.now >= ctx.windowEnd) {
    return denyResult('WINDOW_ENDED');
  }

  // 8. ALREADY_INSIDE — BR-15
  if (ctx.visitorAlreadyInsideElsewhere) {
    return denyResult('ALREADY_INSIDE');
  }

  // 9-10. Flags accumulate; never stop evaluation.
  const flags: RuleCode[] = [];
  if (!ctx.gpsOk) {
    flags.push('LOCATION_UNVERIFIED');
  }
  if (ctx.hostActiveDayGuestCount >= cfg.max_active_day_guests) {
    flags.push('HOST_DAY_LIMIT');
  }

  return flaggedResult(flags);
}
