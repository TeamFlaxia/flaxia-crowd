import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the EmbeddingGemma 2 quantization choice.
 *
 * The `q8` files (`*_quantized.onnx`) keep the embedding tables block
 * quantized, which needs `com.microsoft::GatherBlockQuantized`. onnxruntime-web
 * only implements that op for the WebGPU/WebNN EPs, so a WASM session fails
 * with ORT error code 9 ("Could not find an implementation for
 * GatherBlockQuantized(1) node with name 'node_embedding_Quant'"). The WASM
 * path must therefore stay on fp16, whose graphs contain no block-quantized
 * op.
 */

const state = vi.hoisted(() => ({
  loadOptions: [] as Array<Record<string, unknown>>,
  failDevices: new Set<string>(),
}));

vi.mock('@huggingface/transformers', () => ({
  AutoProcessor: {
    from_pretrained: async () => async () => ({}),
  },
  AutoModel: {
    from_pretrained: async (_id: string, options: Record<string, unknown>) => {
      state.loadOptions.push(options);
      const device = String(options.device ?? '');
      if (state.failDevices.has(device)) {
        throw new Error(`simulated ${device} load failure`);
      }
      return async () => ({ sentence_embedding: { data: new Float32Array(768) } });
    },
  },
  env: { backends: { onnx: { wasm: {} } } },
  loadImage: vi.fn(),
  loadAudio: vi.fn(),
  loadVideo: vi.fn(),
}));

import { dtypeForEmbeddingDevice, handleVectorEmbed, releaseCache } from '../vector-embed';

function setWebGpu(available: boolean): void {
  Object.defineProperty(navigator, 'gpu', {
    value: available ? {} : undefined,
    configurable: true,
  });
}

describe('vector-embed quantization per execution provider', () => {
  beforeEach(() => {
    state.loadOptions.length = 0;
    state.failDevices.clear();
    setWebGpu(false);
    releaseCache();
  });

  it('keeps the WASM path on fp16 (no block-quantized ops)', () => {
    expect(dtypeForEmbeddingDevice('wasm')).toBe('fp16');
    expect(dtypeForEmbeddingDevice('webgpu')).toBe('q8');
  });

  it('loads the WASM model with fp16 when WebGPU is unavailable', async () => {
    await handleVectorEmbed({ text: 'hello' } as any);

    expect(state.loadOptions).toHaveLength(1);
    expect(state.loadOptions[0]!.device).toBe('wasm');
    expect(state.loadOptions[0]!.dtype).toBe('fp16');
  });

  it('loads the WebGPU model with q8 when the device is available', async () => {
    setWebGpu(true);

    await handleVectorEmbed({ text: 'hello' } as any);

    expect(state.loadOptions).toHaveLength(1);
    expect(state.loadOptions[0]!.device).toBe('webgpu');
    expect(state.loadOptions[0]!.dtype).toBe('q8');
  });

  it('falls back to WASM fp16 after a failed WebGPU load', async () => {
    setWebGpu(true);
    state.failDevices.add('webgpu');

    await handleVectorEmbed({ text: 'hello' } as any);

    expect(state.loadOptions.map((options) => options.device)).toEqual(['webgpu', 'wasm']);
    expect(state.loadOptions[1]!.dtype).toBe('fp16');
  });
});
