/**
 * Single wasm bootstrap for every FriedFlaxia workload.
 *
 * The vendored wasm-bindgen glue already de-duplicates its own instantiation,
 * but each workload used to keep its own `wasmReady` promise. A failure left
 * that promise rejected forever, so a later task could never retry. Keeping
 * the cache here clears it on failure and gives all five wrappers one path.
 *
 * The default artifact is built with `+simd128`. Browsers without wasm SIMD
 * load the baseline module instead; both use the same generated glue.
 */

let wasmReady: Promise<void> | null = null;

/**
 * Minimal module that only validates when the engine implements wasm SIMD.
 * Kept inline so detection does not fetch or compile the 2 MB runtime.
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1,
  8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** Whether this engine can instantiate the `+simd128` wasm artifact. */
export function hasWasmSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export async function initFriedFlaxiaWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const glue = await import('./friedflaxia_wasm.js');
      if (hasWasmSimd()) {
        try {
          await glue.default();
          return;
        } catch {
          // A false-positive probe (or a damaged SIMD artifact) can still fail
          // at compile time. Retry once with the baseline module.
        }
      }
      await glue.default(
        new URL('./friedflaxia_wasm_bg.scalar.wasm?no-inline', import.meta.url),
      );
    })().catch((error) => {
      wasmReady = null;
      throw error;
    });
  }
  return wasmReady;
}

/** Fall back to scalar kernels if a device shows a parity regression. */
export async function setFriedFlaxiaSimdEnabled(enabled: boolean): Promise<void> {
  const glue = await import('./friedflaxia_wasm.js');
  glue.set_simd_enabled(enabled);
}

/** Test seam: drop the cached instantiation promise. */
export const resetFriedFlaxiaWasmForTests = (): void => {
  wasmReady = null;
};
