import { describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1, RulesConfigSchema } from './config.js';

describe('RulesConfigSchema (SDD §4.3)', () => {
  it('accepts the exact GH-8 v1 config from the SDD', () => {
    const result = RulesConfigSchema.safeParse(GH8_RULES_CONFIG_V1);
    expect(result.success).toBe(true);
  });

  it('parses the raw §4.3 JSON literal (not the typed constant) identically', () => {
    const raw = {
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
    const result = RulesConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(GH8_RULES_CONFIG_V1);
  });

  it('rejects hostel_gender: "undisclosed" (hostels.gender_served excludes it, SDD §11.2)', () => {
    const invalid = { ...GH8_RULES_CONFIG_V1, hostel_gender: 'undisclosed' };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a malformed time-of-day string', () => {
    const invalid = { ...GH8_RULES_CONFIG_V1, hard_cutoff: '22:00:00' };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an out-of-range time-of-day string', () => {
    const invalid = { ...GH8_RULES_CONFIG_V1, hard_cutoff: '25:00' };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects opposite_gender.allow_overnight: true (BR-07 forbids it unconditionally)', () => {
    const invalid = {
      ...GH8_RULES_CONFIG_V1,
      opposite_gender: { zone: 'visitors_room', allow_overnight: true },
    };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { timezone: _timezone, ...withoutTimezone } = GH8_RULES_CONFIG_V1;
    expect(RulesConfigSchema.safeParse(withoutTimezone).success).toBe(false);
  });

  it('rejects a negative max_active_day_guests', () => {
    const invalid = { ...GH8_RULES_CONFIG_V1, max_active_day_guests: -1 };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a non-integer charge_per_night_inr (CLAUDE.md §2: integer rupees, no paise/floats)', () => {
    const invalid = {
      ...GH8_RULES_CONFIG_V1,
      guest_room: { ...GH8_RULES_CONFIG_V1.guest_room, charge_per_night_inr: 150.5 },
    };
    expect(RulesConfigSchema.safeParse(invalid).success).toBe(false);
  });
});
