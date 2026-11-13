// Probes a bounded lower bound of WebAssembly linear memory the runtime can
// reserve, rather than trusting navigator.deviceMemory (which mobile Chrome
// reports as a quantized value). It grows pages only up to the requested
// target; it must never probe the engine's full maximum because that can
// commit several GiB during startup. Results are memoized so the probe runs at
// most once per page.
//
// Growing a WebAssembly.Memory only reserves address space. Writing to a page
// is what forces the engine to commit physical RAM. A probe that touches every
// page of a 2 GiB target commits 2 GiB in the worker *and* 2 GiB on the main
// thread, which is enough to kill a 4 GB phone before any model is loaded. We
// therefore grow the full target (proving the engine can reserve it) but write
// only a small prefix (proving commit works at all).

export const HEAVY_WORKLOAD_WASM_MEMORY_BYTES = 2 * 1024 ** 3;
const WASM_PAGE_SIZE = 65536;
const PROBE_CHUNK_BYTES = 16 * 1024 * 1024;
/** Hard cap on grow() calls so a tiny `chunkBytes` cannot spin for minutes. */
const MAX_PROBE_STEPS = 4096;
/**
 * Upper bound on pages the probe actually writes. Keeps the probe's physical
 * footprint to a few dozen MiB even when the target is 2 GiB.
 */
const PROBE_COMMIT_BYTES = 64 * 1024 * 1024;

/** A bounded probe result is a known lower bound, not the engine maximum. */
interface ProbeEntry {
  bytes: number;
  sampledAt: number;
  measured: boolean;
}
let cachedProbe: ProbeEntry | null = null;
let probeRuns = 0;

/**
 * Grow `memory` by `bytes`, writing at most `commitBytes` pages so the probe
 * measures reservation without forcing the engine to commit the whole target.
 */
function tryGrow(memory: WebAssembly.Memory, bytes: number, commitBytes: number): boolean {
  const pages = Math.ceil(bytes / WASM_PAGE_SIZE);
  try {
    memory.grow(pages);
  } catch {
    return false;
  }
  if (commitBytes <= 0) return true;
  const view = new Uint8Array(memory.buffer);
  const limit = Math.min(view.byteLength, Math.floor(commitBytes / WASM_PAGE_SIZE) * WASM_PAGE_SIZE);
  for (let p = 0; p < limit; p += WASM_PAGE_SIZE) {
    view[p] = 0;
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
  const sampledAt = Date.now();
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: 0 });
  } catch {
    cachedProbe = { bytes: 0, sampledAt, measured: false };
    return 0;
  }

  const target = Math.max(0, Math.floor(targetBytes));
  const chunk = Math.max(WASM_PAGE_SIZE, Math.floor(chunkBytes));
  let grown = 0;
  let committed = 0;
  let steps = 0;
  while (grown < target && steps < MAX_PROBE_STEPS) {
    const step = Math.min(chunk, target - grown);
    const commit = Math.max(0, Math.min(step, PROBE_COMMIT_BYTES - committed));
    if (!tryGrow(memory, step, commit)) break;
    grown += step;
    committed += commit;
    steps++;
  }

  // Drop the last local reference promptly; the runtime may reclaim committed
  // pages after GC, but they are never retained by the node.
  memory = undefined as unknown as WebAssembly.Memory;
  cachedProbe = { bytes: grown, sampledAt, measured: true };
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

/** The one-shot lower-bound observation, including when the runtime could not create WASM memory. */
export function getWasmMemoryProbeObservation(): { bytes: number | null; sampledAt: number | null } {
  if (!cachedProbe) probeMaxWasmMemoryBytes();
  return {
    bytes: cachedProbe?.measured ? cachedProbe.bytes : null,
    sampledAt: cachedProbe?.sampledAt ?? null,
  };
}

/**
 * Minimum `navigator.deviceMemory` (GiB) accepted for a heavy workload when the
 * API is available. The value is quantized (0.25/0.5/1/2/4/8), so a 4 GB phone
 * reports `4` and is excluded, while an 8 GB laptop reports `8` and is allowed.
 * The WASM probe alone cannot make this distinction: a 4 GB device can reserve
 * 2 GiB of address space and still die when the model actually commits it.
 */
export const MIN_HEAVY_DEVICE_MEMORY_GIB = 8;

/** The device's advertised RAM in GiB, or undefined when the API is unavailable. */
export function getDeviceMemoryGib(): number | undefined {
  try {
    const value = (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the device's physical RAM leaves headroom for a multi-GB model. When
 * `navigator.deviceMemory` is absent (mobile WebViews) we fall back to trusting
 * the WASM probe rather than excluding the device outright.
 */
export function hasDeviceMemoryHeadroom(): boolean {
  const deviceMemory = getDeviceMemoryGib();
  return deviceMemory === undefined || deviceMemory >= MIN_HEAVY_DEVICE_MEMORY_GIB;
}

/**
 * Whether the device can commit the memory a heavy (multi-GB model) workload
 * needs. Uses the cached probe, so it never re-allocates, and additionally
 * requires physical-RAM headroom so a 4 GB phone is never routed a model that
 * would get its tab killed.
 */
export function hasEnoughWasmMemoryForHeavy(): boolean {
  return getWasmMemoryBytes() >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES && hasDeviceMemoryHeadroom();
}

/**
 * The memory value to advertise to the orchestrator. Returns 0 on a
 * memory-constrained device so the coordinator's `isLowMemoryNode` gate stays
 * truthful instead of routing heavy workloads from a raw reservation probe.
 */
export function getAdvertisedWasmMemoryBytes(): number {
  return hasEnoughWasmMemoryForHeavy() ? getWasmMemoryBytes() : 0;
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
