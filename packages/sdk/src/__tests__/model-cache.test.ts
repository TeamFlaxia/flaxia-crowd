import { describe, expect, it } from 'vitest';
import { isNodeModelCacheSnapshot } from '../model-cache';

describe('node model cache snapshot', () => {
  const now = Date.now();
  const base = {
    version: 1,
    sampledAt: now,
    expiresAt: now + 60_000,
    entries: [{ modelId: 'model', revision: 'rev1', dtype: 'q4f16', backend: 'wasm', state: 'ready', referenceCount: 1 }],
  };

  it('accepts a fresh executable state and rejects stale or malformed entries', () => {
    expect(isNodeModelCacheSnapshot(base, now)).toBe(true);
    expect(isNodeModelCacheSnapshot(base, now + 60_001)).toBe(false);
    expect(isNodeModelCacheSnapshot({ ...base, entries: [{ ...base.entries[0], referenceCount: -1 }] }, now)).toBe(false);
    expect(isNodeModelCacheSnapshot({ ...base, entries: Array(9).fill(base.entries[0]) }, now)).toBe(false);
  });

  it('keeps an explicit layer range bounded', () => {
    expect(isNodeModelCacheSnapshot({ ...base, entries: [{ ...base.entries[0], layerRange: [4, 12] }] }, now)).toBe(true);
    expect(isNodeModelCacheSnapshot({ ...base, entries: [{ ...base.entries[0], layerRange: [4, 1e9] }] }, now)).toBe(false);
  });
});
