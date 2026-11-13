import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  probeMaxWasmMemoryBytes,
  hasEnoughWasmMemoryForHeavy,
  getWasmMemoryBytes,
  getWasmMemoryProbeRuns,
  getAdvertisedWasmMemoryBytes,
  hasDeviceMemoryHeadroom,
  getDeviceMemoryGib,
  resetWasmMemoryProbeCache,
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  MIN_HEAVY_DEVICE_MEMORY_GIB,
} from '../memoryProbe';

const PAGE = 65536;
const GB = 1024 ** 3;
const COMMIT_BYTES = 64 * 1024 * 1024;

describe('memoryProbe', () => {
  const original = (globalThis as any).WebAssembly;
  const originalUint8Array = (globalThis as any).Uint8Array;

  beforeEach(() => {
    resetWasmMemoryProbeCache();
  });

  afterEach(() => {
    (globalThis as any).WebAssembly = original;
    (globalThis as any).Uint8Array = originalUint8Array;
    delete (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    resetWasmMemoryProbeCache();
  });

  function setDeviceMemory(value: number | undefined): void {
    Object.defineProperty(navigator, 'deviceMemory', { value, configurable: true });
  }

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

  it('writes only a bounded prefix of a multi-GiB probe instead of committing it all', () => {
    // The probe must grow the full target (to prove the engine can reserve it)
    // but only write a small prefix. Writing every page commits 2 GiB in the
    // worker and 2 GiB on the main thread, which is what kills a 4 GB phone.
    const touchedPages: number[] = [];
    const maxPages = Math.floor((4 * GB) / PAGE);
    let pages = 0;

    class MockMemory {
      readonly buffer: { grownBytes: number } = { grownBytes: 0 };
      grow(extra: number): number {
        if (pages + extra > maxPages) throw new RangeError('grow failed');
        const prev = pages;
        pages += extra;
        this.buffer.grownBytes = pages * PAGE;
        return prev;
      }
    }

    class FakeUint8Array {
      constructor(buffer: { grownBytes: number }) {
        const target: Record<string | symbol, unknown> = { byteLength: buffer.grownBytes };
        return new Proxy(target, {
          set(t, prop, value) {
            if (typeof prop === 'string' && /^\d+$/.test(prop)) touchedPages.push(Number(prop));
            t[prop] = value;
            return true;
          },
        }) as unknown as FakeUint8Array;
      }
    }

    (globalThis as any).WebAssembly = { Memory: MockMemory as any };
    (globalThis as any).Uint8Array = FakeUint8Array;

    const bytes = probeMaxWasmMemoryBytes();
    expect(bytes).toBe(HEAVY_WORKLOAD_WASM_MEMORY_BYTES);
    expect(touchedPages.length).toBe(COMMIT_BYTES / PAGE);
  });

  it('excludes a 4 GB phone from heavy workloads even when the probe succeeds', () => {
    installMock(4 * GB);
    setDeviceMemory(4);

    expect(probeMaxWasmMemoryBytes()).toBe(HEAVY_WORKLOAD_WASM_MEMORY_BYTES);
    expect(getDeviceMemoryGib()).toBe(4);
    expect(hasDeviceMemoryHeadroom()).toBe(false);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(false);
    expect(getAdvertisedWasmMemoryBytes()).toBe(0);
  });

  it('allows an 8 GB device when the probe succeeds', () => {
    installMock(4 * GB);
    setDeviceMemory(8);

    expect(hasDeviceMemoryHeadroom()).toBe(true);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(true);
    expect(getAdvertisedWasmMemoryBytes()).toBe(HEAVY_WORKLOAD_WASM_MEMORY_BYTES);
  });

  it('falls back to the probe when navigator.deviceMemory is unavailable', () => {
    installMock(4 * GB);
    setDeviceMemory(undefined);

    expect(getDeviceMemoryGib()).toBeUndefined();
    expect(hasDeviceMemoryHeadroom()).toBe(true);
    expect(hasEnoughWasmMemoryForHeavy()).toBe(true);
  });

  it('advertises the minimum heavy device memory threshold', () => {
    expect(MIN_HEAVY_DEVICE_MEMORY_GIB).toBe(8);
  });
});