import { describe, expect, it } from 'vitest';
import { assertPhoneAllowedHere, TEST_PHONES_ONLY_MESSAGE } from './test-phones.js';

/** DEC-028: staging takes the SDD §9.5 test numbers only; local and production any. */
describe('assertPhoneAllowedHere', () => {
  it('lets every test number through in staging and refuses any other', () => {
    for (let n = 1; n <= 9; n++) {
      expect(() =>
        assertPhoneAllowedHere({ APP_ENV: 'staging' }, `+91999990000${n}`),
      ).not.toThrow();
    }
    for (const phone of ['+919812345678', '+919999900010', '+919999900000']) {
      expect(() => assertPhoneAllowedHere({ APP_ENV: 'staging' }, phone)).toThrow(
        TEST_PHONES_ONLY_MESSAGE,
      );
    }
  });

  it('changes nothing in local or production', () => {
    for (const APP_ENV of ['local', 'production'] as const) {
      expect(() => assertPhoneAllowedHere({ APP_ENV }, '+919812345678')).not.toThrow();
    }
  });
});
