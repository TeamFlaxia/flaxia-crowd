import { describe, expect, it } from 'vitest';
import { estimateSerializedBytes, isResultWithinLimit, MAX_TASK_RESULT_BYTES } from '../resultLimits';

describe('resultLimits', () => {
  it('exposes the orchestrator-matching result cap', () => {
    expect(MAX_TASK_RESULT_BYTES).toBe(4 * 1024 * 1024);
  });

  it('accepts a small result', () => {
    expect(isResultWithinLimit({ output: 'ok' })).toBe(true);
    expect(isResultWithinLimit({ imageBase64: 'x'.repeat(1024) })).toBe(true);
  });

  it('rejects a result above the cap without serializing it', () => {
    const oversized = { imageBase64: 'x'.repeat(MAX_TASK_RESULT_BYTES) };
    expect(isResultWithinLimit(oversized)).toBe(false);
    expect(estimateSerializedBytes(oversized)).toBeGreaterThan(MAX_TASK_RESULT_BYTES);
  });

  it('walks nested structures and exits early once the cap is exceeded', () => {
    const nested = { items: [{ blob: 'a'.repeat(1024) }, { blob: 'b'.repeat(1024) }] };
    expect(estimateSerializedBytes(nested)).toBeLessThan(MAX_TASK_RESULT_BYTES);
    expect(isResultWithinLimit(nested)).toBe(true);

    const huge = { items: new Array(4000).fill({ blob: 'a'.repeat(1024) }) };
    expect(isResultWithinLimit(huge)).toBe(false);
  });

  it('handles primitives and null-like values', () => {
    expect(estimateSerializedBytes(null)).toBe(0);
    expect(estimateSerializedBytes(undefined)).toBe(0);
    expect(estimateSerializedBytes(42)).toBe(16);
    expect(estimateSerializedBytes('abcd')).toBe(8);
  });
});
