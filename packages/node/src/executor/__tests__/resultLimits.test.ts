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
    expect(estimateSerializedBytes(42)).toBe(24);
    expect(estimateSerializedBytes('abcd')).toBe(14);
  });

  it('counts UTF-8 bytes, so multibyte text near the cap is rejected', () => {
    // 1.5M Japanese characters serialize to ~4.5 MiB of UTF-8 even though
    // their UTF-16 code-unit count is below the 4 MiB budget.
    const multibyte = { output: 'あ'.repeat(1_500_000) };
    const realBytes = new TextEncoder().encode(JSON.stringify(multibyte)).byteLength;
    expect(realBytes).toBeGreaterThan(MAX_TASK_RESULT_BYTES);
    expect(estimateSerializedBytes(multibyte)).toBeGreaterThanOrEqual(realBytes);
    expect(isResultWithinLimit(multibyte)).toBe(false);

    const within = { output: 'あ'.repeat(1_000_000) };
    const withinBytes = new TextEncoder().encode(JSON.stringify(within)).byteLength;
    expect(withinBytes).toBeLessThan(MAX_TASK_RESULT_BYTES);
    expect(isResultWithinLimit(within)).toBe(true);
  });

  it('counts object keys and escapes as part of the serialized budget', () => {
    const escaped = { 'キー': '\n\u0000"\\' };
    const realBytes = new TextEncoder().encode(JSON.stringify(escaped)).byteLength;
    expect(estimateSerializedBytes(escaped)).toBeGreaterThanOrEqual(realBytes);
  });
});
