import { describe, expect, it } from 'vitest';
import { hasWasmSimd } from '../init';

describe('FriedFlaxia wasm bootstrap', () => {
  it('detects wasm SIMD support without fetching the runtime', () => {
    // Node 22 implements wasm SIMD, so the probe must validate here.
    expect(hasWasmSimd()).toBe(true);
  });

  it('rejects the probe when WebAssembly.validate throws', () => {
    const original = WebAssembly.validate;
    WebAssembly.validate = () => {
      throw new Error('disabled');
    };
    try {
      expect(hasWasmSimd()).toBe(false);
    } finally {
      WebAssembly.validate = original;
    }
  });
});
