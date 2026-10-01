import { describe, expect, it } from 'vitest';
import { GH8_RULES_CONFIG_V1 } from './config.js';
import { computeZone, isOppositeGender } from './zone.js';

describe('isOppositeGender (BR-07)', () => {
  it('same gender as hostel is not opposite', () => {
    expect(isOppositeGender('female', 'female')).toBe(false);
  });

  it('a different gender is opposite', () => {
    expect(isOppositeGender('male', 'female')).toBe(true);
  });

  it('undisclosed is treated as opposite (config undisclosed_gender_as_opposite: true)', () => {
    expect(isOppositeGender('undisclosed', 'female')).toBe(true);
  });

  it('null (not yet known) is treated as opposite — the conservative default', () => {
    expect(isOppositeGender(null, 'female')).toBe(true);
  });
});

describe('computeZone (BR-07, visit type table SDD §4.1)', () => {
  it('quick_drop is always zoned "gate", regardless of gender', () => {
    expect(computeZone('quick_drop', 'female', 'female', GH8_RULES_CONFIG_V1)).toBe('gate');
    expect(computeZone('quick_drop', 'male', 'female', GH8_RULES_CONFIG_V1)).toBe('gate');
  });

  it('day visit: same-gender guest zones to "room"', () => {
    expect(computeZone('day', 'female', 'female', GH8_RULES_CONFIG_V1)).toBe('room');
  });

  it('day visit: opposite-gender guest zones to "visitors_room" (worked example: male guest, day invite, GH-8 → allow, zone visitors_room)', () => {
    expect(computeZone('day', 'male', 'female', GH8_RULES_CONFIG_V1)).toBe('visitors_room');
  });

  it('day visit: undisclosed-gender guest zones to "visitors_room" (TC-RULE-12)', () => {
    expect(computeZone('day', 'undisclosed', 'female', GH8_RULES_CONFIG_V1)).toBe('visitors_room');
  });

  it('day visit: unknown (null) gender zones to "visitors_room" (conservative default)', () => {
    expect(computeZone('day', null, 'female', GH8_RULES_CONFIG_V1)).toBe('visitors_room');
  });

  it('overnight_room zones to "room" (only reachable for same-gender guests)', () => {
    expect(computeZone('overnight_room', 'female', 'female', GH8_RULES_CONFIG_V1)).toBe('room');
  });

  it('guest_room zones to "guest_room" regardless of gender field (only reachable for same-gender guests)', () => {
    expect(computeZone('guest_room', 'female', 'female', GH8_RULES_CONFIG_V1)).toBe('guest_room');
  });

  it('uses the configured opposite_gender.zone value rather than a hardcoded literal', () => {
    const customCfg = {
      ...GH8_RULES_CONFIG_V1,
      opposite_gender: { zone: 'visitors_room' as const, allow_overnight: false as const },
    };
    expect(computeZone('day', 'male', 'female', customCfg)).toBe(customCfg.opposite_gender.zone);
  });
});
