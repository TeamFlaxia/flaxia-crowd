// Probes the real amount of WebAssembly linear memory the runtime can actually
// commit, rather than trusting navigator.deviceMemory (which mobile Chrome
// reports as a quantized value and is therefore useless for gating heavy WASM
// workloads). We grow a WebAssembly.Memory in chunks and write into every page
// so the engine is forced to actually commit physical memory. If the runtime
// cannot grow far enough it throws a RangeError, which we catch cleanly — no
// OOM crash, unlike actually loading a multi-GB model on an underpowered phone.

export const HEAVY_WORKLOAD_WASM_MEMORY_BYTES = 2 * 1024 ** 3;
const WASM_PAGE_SIZE = 65536;
const PROBE_CHUNK_BYTES = 16 * 1024 * 1024;

export function probeMaxWasmMemoryBytes(
  targetBytes: number = HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  chunkBytes: number = PROBE_CHUNK_BYTES,
): number {
  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: 0 });
  } catch {
    // Environment without growable memory (or memory creation blocked).
    return 0;
  }

  let grown = 0;
  while (grown < targetBytes) {
    const remaining = targetBytes - grown;
    const pages = Math.ceil(Math.min(chunkBytes, remaining) / WASM_PAGE_SIZE);
    try {
      memory.grow(pages);
    } catch {
      // Cannot grow any further: stop. The bytes already committed are the max.
      break;
    }
    // Touch every newly grown page so the OS/engine actually commits RAM
    // instead of reporting success on lazily-backed virtual memory.
    const view = new Uint8Array(memory.buffer);
    for (let p = 0; p < pages; p++) {
      view[grown + p * WASM_PAGE_SIZE] = 0;
    }
    grown += pages * WASM_PAGE_SIZE;
  }
  return grown;
}

export function hasEnoughWasmMemoryForHeavy(): boolean {
  return probeMaxWasmMemoryBytes() >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES;
}
