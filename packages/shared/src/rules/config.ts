import { z } from 'zod';

/**
 * GH-8 rules config schema (SDD §4.3). Stored verbatim in `hostel_rules.config`
 * (jsonb) — field names stay snake_case because this is the literal stored/versioned
 * config shape the SDD specifies, not an API response DTO (those are camelCase;
 * this isn't one). "The API refuses to save an invalid config" (SDD §4.3) — this
 * schema is that validation.
 */

const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be a 24-hour HH:MM time string, e.g. "08:00"');

export const GenderSchema = z.enum(['female', 'male', 'undisclosed']);
export type Gender = z.infer<typeof GenderSchema>;

/** `hostels.gender_served` excludes 'undisclosed' at the database level (SDD §11.2). */
export const HostelGenderSchema = z.enum(['female', 'male']);
export type HostelGender = z.infer<typeof HostelGenderSchema>;

export const VisitTypeSchema = z.enum(['quick_drop', 'day', 'overnight_room', 'guest_room']);
export type VisitType = z.infer<typeof VisitTypeSchema>;

export const ZoneSchema = z.enum(['gate', 'visitors_room', 'room', 'guest_room']);
export type Zone = z.infer<typeof ZoneSchema>;

export const RulesConfigSchema = z.object({
  timezone: z.string().min(1), // SDD §4.3: "Asia/Kolkata"
  hostel_gender: HostelGenderSchema,

  visiting_start: TimeOfDaySchema, // BR-04 lower bound; BR-19 overnight check-in window start
  last_entry_day: TimeOfDaySchema, // BR-02: day/quick_drop entry cutoff (AFTER_ENTRY_CUTOFF)
  hard_cutoff: TimeOfDaySchema, // BR-03: entry cutoff for every type (AFTER_HARD_CUTOFF)
  day_visit_latest_end: TimeOfDaySchema, // BR-04 upper bound for a day-visit window's end time
  overnight_checkout_time: TimeOfDaySchema, // BR-19: overnight check-out-by time on departure date

  early_arrival_minutes: z.number().int().nonnegative(), // BR-20
  overstay_grace_minutes: z.number().int().nonnegative(), // BR-13, evaluateExit LATE_EXIT
  quick_drop_minutes: z.number().int().positive(),
  walk_in_timeout_minutes: z.number().int().positive(), // BR-12 (job, not this engine)
  dispute_window_minutes: z.number().int().positive(), // FR-42 (not this engine)

  max_active_day_guests: z.number().int().positive(), // BR-11
  invite_max_days_ahead: z.number().int().positive(), // BR-16
  overnight_max_days_ahead: z.number().int().positive(), // BR-16

  overnight_room: z.object({
    enabled: z.boolean(),
    max_nights_per_month: z.number().int().positive(), // BR-05
    max_concurrent: z.number().int().positive(), // BR-06
    charge_per_night_inr: z.number().int().nonnegative(), // BR-08 — integer rupees, CLAUDE.md §2
  }),
  guest_room: z.object({
    enabled: z.boolean(),
    charge_per_night_inr: z.number().int().nonnegative(), // BR-08
  }),

  opposite_gender: z.object({
    zone: ZoneSchema, // BR-07: 'visitors_room'
    allow_overnight: z.literal(false), // BR-07: opposite gender can never book overnight types
  }),
  undisclosed_gender_as_opposite: z.boolean(), // BR-07

  min_manual_fine_inr: z.number().int().nonnegative(), // BR-18 (warden action, not this engine)
  night_sweep_time: TimeOfDaySchema, // BR-14 (job, not this engine)
});

export type RulesConfig = z.infer<typeof RulesConfigSchema>;

/**
 * The exact GH-8 v1 config from SDD §4.3, for tests and local/staging seeding — not
 * exported for production use beyond that (a real deployment reads the config from
 * `hostel_rules.config`, it doesn't hardcode it).
 */
export const GH8_RULES_CONFIG_V1: RulesConfig = {
  timezone: 'Asia/Kolkata',
  hostel_gender: 'female',
  visiting_start: '08:00',
  last_entry_day: '20:00',
  hard_cutoff: '22:00',
  day_visit_latest_end: '22:00',
  overnight_checkout_time: '12:00',
  early_arrival_minutes: 30,
  overstay_grace_minutes: 15,
  quick_drop_minutes: 15,
  walk_in_timeout_minutes: 10,
  dispute_window_minutes: 30,
  max_active_day_guests: 3,
  invite_max_days_ahead: 7,
  overnight_max_days_ahead: 30,
  overnight_room: {
    enabled: true,
    max_nights_per_month: 3,
    max_concurrent: 1,
    charge_per_night_inr: 50,
  },
  guest_room: { enabled: true, charge_per_night_inr: 150 },
  opposite_gender: { zone: 'visitors_room', allow_overnight: false },
  undisclosed_gender_as_opposite: true,
  min_manual_fine_inr: 400,
  night_sweep_time: '22:00',
};
