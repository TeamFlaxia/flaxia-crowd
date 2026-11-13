import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEmbedGemma, releaseCache } from '../embed-gemma';

const state = vi.hoisted(() => ({
  modelCalls: [] as number[],
  loadOptions: [] as Array<Record<string, unknown>>,
  disposeCalls: [] as string[],
}));

vi.mock('@huggingface/transformers', () => ({
  AutoConfig: {
    from_pretrained: async () => ({ vision_config: {}, audio_config: {} }),
  },
  AutoProcessor: {
    from_pretrained: async () => {
      const processor = async (texts: string[]) => ({ texts });
      (processor as unknown as { dispose: () => void }).dispose = () => {
        state.disposeCalls.push('processor');
      };
      return processor;
    },
  },
  AutoModel: {
    from_pretrained: async (_id: string, options: Record<string, unknown>) => {
      state.loadOptions.push(options);
      const model = async (processed: { texts: string[] }) => {
        state.modelCalls.push(processed.texts.length);
        const data = new Float32Array(processed.texts.length * 768);
        for (let item = 0; item < processed.texts.length; item += 1) {
          for (let index = 0; index < 768; index += 1) {
            data[item * 768 + index] = index + 1;
          }
        }
        return { sentence_embedding: { data } };
      };
      (model as unknown as { dispose: () => void }).dispose = () => {
        state.disposeCalls.push('model');
      };
      return model;
    },
  },
  env: { backends: { onnx: { wasm: {} } } },
}));

function norm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe('embed-gemma workload', () => {
  beforeEach(() => {
    state.modelCalls.length = 0;
    state.loadOptions.length = 0;
    state.disposeCalls.length = 0;
    releaseCache();
  });

  it('embeds a batch and truncates to the requested MRL dimension', async () => {
    const result = await handleEmbedGemma({ texts: ['first', 'second'], dimensions: 512 });

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(512);
    expect(result.vectors[1]).toHaveLength(512);
    expect(Math.abs(norm(result.vectors[0]!) - 1)).toBeLessThan(1e-6);
    expect(result.dimensions).toBe(512);
    expect(result.model).toBe('google/embeddinggemma-2');
    expect(state.modelCalls).toEqual([2]);
  });

  it('loads text-only encoders with the WASM fp16 fallback', async () => {
    await handleEmbedGemma({ texts: ['hello'], dimensions: 768 });

    expect(state.loadOptions).toHaveLength(1);
    const options = state.loadOptions[0]!;
    expect(options.device).toBe('wasm');
    expect(options.dtype).toBe('fp16');
    expect(options.revision).toBe('main');
    expect((options.config as any).vision_config).toBeNull();
    expect((options.config as any).audio_config).toBeNull();
  });

  it('splits large inputs into bounded model calls', async () => {
    await handleEmbedGemma({ texts: ['a', 'b', 'c', 'd', 'e'], dimensions: 256 });
    expect(state.modelCalls).toEqual([4, 1]);
  });

  it('yields to the CPU throttle between model calls', async () => {
    let yields = 0;
    await handleEmbedGemma({ texts: ['a', 'b', 'c', 'd', 'e'], dimensions: 256 }, () => {
      yields += 1;
    });
    expect(yields).toBe(2);
  });

  it('rejects empty, oversized or invalid payloads', async () => {
    await expect(handleEmbedGemma({ texts: [] })).rejects.toThrow(/texts/);
    await expect(handleEmbedGemma({ texts: [''] })).rejects.toThrow(/non-empty/);
    await expect(handleEmbedGemma({ texts: ['x'.repeat(4001)] })).rejects.toThrow(/4000/);
    await expect(handleEmbedGemma({ texts: ['ok'], dimensions: 100 as any })).rejects.toThrow(/dimensions/);
  });

  it('disposes the model and processor on releaseCache instead of pinning the wasm heap', async () => {
    await handleEmbedGemma({ texts: ['hello'], dimensions: 768 });
    expect(state.disposeCalls).toHaveLength(0);

    releaseCache();

    expect(state.disposeCalls).toContain('model');
    expect(state.disposeCalls).toContain('processor');
  });
});
