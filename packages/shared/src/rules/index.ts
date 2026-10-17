export {
  GH8_RULES_CONFIG_V1,
  GenderSchema,
  HostelGenderSchema,
  RulesConfigSchema,
  VisitTypeSchema,
  ZoneSchema,
} from './config.js';
export type { Gender, HostelGender, RulesConfig, VisitType, Zone } from './config.js';

export { evaluateCreate } from './evaluate-create.js';
export { evaluateEntry } from './evaluate-entry.js';
export { evaluateExit } from './evaluate-exit.js';
export { monthsTouched, nightsBetween, quotaUsed } from './nights.js';
export { computeZone, isOppositeGender } from './zone.js';
export { localDateTimeToUtc, toLocalDateString } from './time.js';

export type {
  CreateContext,
  Decision,
  EntryContext,
  ExistingOvernightBooking,
  ExitContext,
  HostState,
  RuleCode,
  RuleResult,
} from './types.js';
