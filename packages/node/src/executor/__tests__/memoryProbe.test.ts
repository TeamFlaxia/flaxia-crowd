import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  probeMaxWasmMemoryBytes,
  hasEnoughWasmMemoryForHeavy,
  getWasmMemoryBytes,
  getWasmMemoryProbeRuns,
  resetWasmMemoryProbeCache,
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
} from '../memoryProbe';

const PAGE = 65536;
const GB = 1024 ** 3;

describe('memoryProbe', () => {
  const original = (globalThis as any).WebAssembly;

  beforeEach(() => {
    resetWasmMemoryProbeCache();
  });

  afterEach(() => {
    (globalThis as any).WebAssembly = original;
    resetWasmMemoryProbeCache();
  });

  // Installs a WebAssembly.Memory mock that can only grow up to `capacityBytes`
  // of committed pages, then throws a RangeError (as a real engine does when
  // it cannot commit more memory). The backing ArrayBuffer is intentionally
  // tiny: writes beyond its length are ignored by the Uint8Array, so the test
  // exercises the probe's grow/commit counting without allocating real RAM.
  function installMock(capacityBytes: number) {
    const maxPages = Math.floor(capacityBytes / PAGE);
    class MockMemory {
      private pages: number;
      readonly buffer: ArrayBuffer;
      constructor(init: { initial: number }) {
        this.pages = init.initial;
        this.buffer = new ArrayBuffer(Math.min(capacityBytes, PAGE * 4));
      }
      grow(pages: number): number {
        const prev = this.pages;
        if (this.pages + pages > maxPages) {
          throw new RangeError('WebAssembly.Memory.grow failed');
        }
        this.pages += pages;
        return prev;
      }
    }
    (globalThis as any).WebAssembly = { Memory: MockMemory as any };
  }

  it('stops after proving the bounded target even if the engine supports more', () => {
    installMock(4 * GB);
    const bytes = probeMaxWasmMemoryBytes();
    expect(bytes).toBe(HEAVY_WORKLOAD_WASM_MEMORY_BYTES);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(true);
  });

  it('stops at the engine limit and reports fewer than the target bytes', () => {
    installMock(1 * GB);
    const bytes = probeMaxWasmMemoryBytes();
    expect(bytes).toBeLessThan(HEAVY_WORKLOAD_WASM_MEMORY_BYTES);
    expect(bytes).toBe(1 * GB);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(false);
  });

  it('returns 0 when a Memory cannot even be constructed', () => {
    (globalThis as any).WebAssembly = {
      Memory: class {
        constructor() {
          throw new Error('Memory creation blocked');
        }
      },
    };
    expect(probeMaxWasmMemoryBytes()).toBe(0);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(false);
  });

  it('memoizes the probe so repeated capability checks never re-allocate (#10-6)', () => {
    installMock(4 * GB);

    const first = getWasmMemoryBytes();
    const runsAfterFirst = getWasmMemoryProbeRuns();

    // A registration followed by reconnect retries asks many times: every call
    // must be served from the cache instead of committing 2 GiB again.
    for (let i = 0; i < 5; i++) {
      expect(getWasmMemoryBytes()).toBe(first);
      expect(hasEnoughWasmMemoryForHeavy()).toBe(true);
    }
    expect(getWasmMemoryProbeRuns()).toBe(runsAfterFirst);
    expect(runsAfterFirst).toBe(1);
  });

  it('does not cache a partial probe against a larger later target', () => {
    installMock(1 * GB);
    expect(probeMaxWasmMemoryBytes(1 * GB)).toBe(1 * GB);
    expect(getWasmMemoryProbeRuns()).toBe(1);

    // The engine cannot grow past 1 GiB, so a bigger target is answered from
    // the cache instead of re-running the allocation.
    expect(probeMaxWasmMemoryBytes(3 * GB)).toBe(1 * GB);
    expect(getWasmMemoryProbeRuns()).toBe(1);
  });

  it('reuses the bounded lower bound for later smaller or larger requests', () => {
    installMock(4 * GB);
    expect(probeMaxWasmMemoryBytes(2 * GB)).toBe(2 * GB);
    expect(probeMaxWasmMemoryBytes(512 * 1024 * 1024)).toBe(2 * GB);
    expect(probeMaxWasmMemoryBytes(3 * GB)).toBe(2 * GB);
    expect(getWasmMemoryProbeRuns()).toBe(1);
  });

  it('never probes beyond the requested target to discover the engine maximum', () => {
    installMock(3 * GB);
    expect(probeMaxWasmMemoryBytes(1 * GB)).toBe(1 * GB);
    expect(getWasmMemoryProbeRuns()).toBe(1);
  });
});