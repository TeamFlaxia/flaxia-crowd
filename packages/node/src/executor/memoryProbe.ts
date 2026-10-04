// Probes the real amount of WebAssembly linear memory the runtime can actually
// commit, rather than trusting navigator.deviceMemory (which mobile Chrome
// reports as a quantized value and is therefore useless for gating heavy WASM
// workloads). We grow a WebAssembly.Memory in chunks and write into every page
// so the engine is forced to actually commit physical memory. If the runtime
// cannot grow far enough it throws a RangeError, which we catch cleanly — no
// OOM crash, unlike actually loading a multi-GB model on an underpowered phone.
//
// The probe commits up to 2 GiB, so it must never run more than once per page.
// The result is memoized here: callers use `getWasmMemoryBytes()` /
// `hasEnoughWasmMemoryForHeavy()` and get the cached value for free (no second
// 2 GiB allocation, including on every reconnect attempt).

export const HEAVY_WORKLOAD_WASM_MEMORY_BYTES = 2 * 1024 ** 3;
const WASM_PAGE_SIZE = 65536;
const PROBE_CHUNK_BYTES = 16 * 1024 * 1024;
/** The most we ever ask for: wasm32 cannot exceed 4 GiB anyway. */
const PROBE_CEILING_BYTES = 8 * 1024 ** 3;
/** Hard cap on grow() calls so a tiny `chunkBytes` cannot spin for minutes. */
const MAX_PROBE_STEPS = 4096;

/**
 * Cache keyed by chunk size. A completed probe returns the engine's real
 * maximum, so it is final (that maximum cannot shrink) and is never repeated.
 */
interface ProbeEntry {
  chunkBytes: number;
  bytes: number;
}
let cachedProbe: ProbeEntry | null = null;
let probeRuns = 0;

/** Grow `memory` by `bytes`, touching every page so the RAM is really committed. */
function tryGrow(memory: WebAssembly.Memory, bytes: number): boolean {
  const pages = Math.ceil(bytes / WASM_PAGE_SIZE);
  try {
    memory.grow(pages);
  } catch {
    return false;
  }
  const view = new Uint8Array(memory.buffer);
  for (let p = 0; p < pages; p++) {
    view[p * WASM_PAGE_SIZE] = 0;
  }
  return true;
}

/**
 * Measure the real amount of WebAssembly linear memory this runtime can commit.
 *
 * `targetBytes` is the amount the probe is required to reach; past it the probe
 * keeps doubling (bounded by `PROBE_CEILING_BYTES`) until the engine refuses.
 * Finding the true maximum is what makes the value cacheable: a later request
 * for more memory cannot invalidate it, so the multi-GB probe runs at most once
 * per page.
 *
 * Prefer `getWasmMemoryBytes()`: this function performs the real (multi-GB)
 * allocation, so calling it more than once per page is wasteful.
 */
export function probeMaxWasmMemoryBytes(
  targetBytes: number = HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  chunkBytes: number = PROBE_CHUNK_BYTES,
): number {
  const cached = cachedProbe;
  if (cached && cached.chunkBytes === chunkBytes) return cached.bytes;

  probeRuns++;
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: 0 });
  } catch {
    // Environment without growable memory (or memory creation blocked).
    cachedProbe = { chunkBytes, bytes: 0 };
    return 0;
  }

  const chunk = Math.max(WASM_PAGE_SIZE, Math.floor(chunkBytes));
  // 1. Grow in chunks until the target is reached, or the engine refuses.
  let grown = 0;
  let steps = 0;
  while (grown < targetBytes && steps < MAX_PROBE_STEPS) {
    const step = Math.min(chunk, targetBytes - grown);
    if (!tryGrow(memory, step)) break;
    grown += step;
    steps++;
  }

  // 2. Target reached: double until the engine refuses, then bisect the last
  // gap so the cached value is the engine's real maximum (a later request for
  // more memory can then never invalidate it).
  if (grown >= targetBytes) {
    let step = Math.max(chunk, targetBytes);
    let failedStep: number | null = null;
    while (grown < PROBE_CEILING_BYTES && steps < MAX_PROBE_STEPS) {
      const next = Math.min(step, PROBE_CEILING_BYTES - grown);
      if (next < WASM_PAGE_SIZE || !tryGrow(memory, next)) {
        failedStep = next;
        break;
      }
      grown += next;
      step *= 2;
      steps++;
    }
    if (failedStep !== null) {
      let low = 0;
      let high = failedStep;
      while (high - low > chunk && steps < MAX_PROBE_STEPS) {
        const mid = Math.floor((low + high) / 2 / WASM_PAGE_SIZE) * WASM_PAGE_SIZE;
        if (mid <= low) break;
        if (tryGrow(memory, mid)) {
          grown += mid;
          low = 0;
          high -= mid;
        } else {
          high = mid;
        }
        steps++;
      }
    }
  }

  cachedProbe = { chunkBytes, bytes: grown };
  return grown;
}

/**
 * The device's committed WebAssembly memory, probed at most once per page.
 * This is the cheap accessor every call site (registration, reconnect,
 * capability reporting) should use instead of `probeMaxWasmMemoryBytes()`.
 */
export function getWasmMemoryBytes(): number {
  if (!cachedProbe) return probeMaxWasmMemoryBytes();
  return cachedProbe.bytes;
}

/**
 * Whether the device can commit the memory a heavy (multi-GB model) workload
 * needs. Uses the cached probe, so it never re-allocates.
 */
export function hasEnoughWasmMemoryForHeavy(): boolean {
  return getWasmMemoryBytes() >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES;
}

/**
 * Drop the memoized probe and reset the run counter. Only for tests that
 * install a fake WebAssembly implementation; production code never needs to
 * reset the cache.
 */
export function resetWasmMemoryProbeCache(): void {
  cachedProbe = null;
  probeRuns = 0;
}

/** How many times the real probe ran (diagnostics / tests). */
export function getWasmMemoryProbeRuns(): number {
  return probeRuns;
}