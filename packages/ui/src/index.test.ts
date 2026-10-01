import { describe, expect, it } from 'vitest';
import { HAVEN_UI_SCAFFOLD_VERSION } from './index.js';

describe('@haven/ui scaffold', () => {
  it('exposes a valid entry point (infra smoke test, not a business-logic test)', () => {
    expect(HAVEN_UI_SCAFFOLD_VERSION).toBe('0.0.0');
  });
});
