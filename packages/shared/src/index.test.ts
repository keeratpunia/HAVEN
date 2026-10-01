import { describe, expect, it } from 'vitest';
import { HAVEN_SHARED_SCAFFOLD_VERSION } from './index.js';

describe('@haven/shared scaffold', () => {
  it('exposes a valid entry point (infra smoke test, not a business-logic test)', () => {
    expect(HAVEN_SHARED_SCAFFOLD_VERSION).toBe('0.0.0');
  });
});
