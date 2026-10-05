// Probes a bounded lower bound of WebAssembly linear memory the runtime can
// commit, rather than trusting navigator.deviceMemory (which mobile Chrome
// reports as a quantized value). It grows and touches pages only up to the
// requested target; it must never probe the engine's full maximum because that
// can commit several GiB during startup. Results are memoized so the probe runs
// at most once per page.

export const HEAVY_WORKLOAD_WASM_MEMORY_BYTES = 2 * 1024 ** 3;
const WASM_PAGE_SIZE = 65536;
const PROBE_CHUNK_BYTES = 16 * 1024 * 1024;
/** Hard cap on grow() calls so a tiny `chunkBytes` cannot spin for minutes. */
const MAX_PROBE_STEPS = 4096;

/** A bounded probe result is a known lower bound, not the engine maximum. */
interface ProbeEntry {
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
 * Probe a bounded lower bound of memory this runtime can commit. The function
 * stops at `targetBytes`; it deliberately does not explore the engine maximum.
 * Only the first call per page allocates/touches memory. If a later caller asks
 * for a higher target, return the already-proven lower bound instead of
 * committing more memory during startup.
 */
export function probeMaxWasmMemoryBytes(
  targetBytes: number = HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  chunkBytes: number = PROBE_CHUNK_BYTES,
): number {
  if (cachedProbe) return cachedProbe.bytes;

  probeRuns++;
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: 0 });
  } catch {
    cachedProbe = { bytes: 0 };
    return 0;
  }

  const target = Math.max(0, Math.floor(targetBytes));
  const chunk = Math.max(WASM_PAGE_SIZE, Math.floor(chunkBytes));
  let grown = 0;
  let steps = 0;
  while (grown < target && steps < MAX_PROBE_STEPS) {
    const step = Math.min(chunk, target - grown);
    if (!tryGrow(memory, step)) break;
    grown += step;
    steps++;
  }

  // Drop the last local reference promptly; the runtime may reclaim committed
  // pages after GC, but they are never retained by the node.
  memory = undefined as unknown as WebAssembly.Memory;
  cachedProbe = { bytes: grown };
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