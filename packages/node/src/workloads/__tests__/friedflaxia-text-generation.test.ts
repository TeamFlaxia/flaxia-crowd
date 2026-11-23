import { describe, expect, it, vi } from 'vitest';
import { FRIEDFLAXIA_PLAMO } from '../friedflaxia/model-registry';
import {
  assertPlamoPayload,
  generateWithModel,
  type PlamoModel,
} from '../friedflaxia/text-generation';

function fakeModel(): PlamoModel {
  return {
    encode: vi.fn(() => Uint32Array.from([1, 16, 19])),
    generate: vi.fn(() => Uint32Array.from([3, 4])),
    generate_stream: undefined,
    decode: vi.fn(() => 'こんにちは'),
    free: vi.fn(),
  };
}

const payload = {
  task: 'text-generation',
  model: FRIEDFLAXIA_PLAMO.modelId,
  input: 'Hello world',
  options: { max_new_tokens: 8, do_sample: false },
};

describe('friedflaxia PLaMO text generation', () => {
  it('encodes, generates with the KV cache, and returns generated_text', async () => {
    const model = fakeModel();
    const result = await generateWithModel(model, payload);

    expect(model.encode).toHaveBeenCalledWith('Hello world', true);
    expect(model.generate).toHaveBeenCalledWith(Uint32Array.from([1, 16, 19]), 8);
    expect(model.decode).toHaveBeenCalledWith(Uint32Array.from([3, 4]));
    expect(result).toEqual({ output: [{ generated_text: 'こんにちは' }] });
  });

  it('streams decoded tokens through onToken when wasm exposes generate_stream', async () => {
    const model = fakeModel();
    const seen: number[] = [];
    model.generate_stream = vi.fn(async (promptIds, maxTokens, onToken) => {
      expect(promptIds).toEqual(Uint32Array.from([1, 16, 19]));
      expect(maxTokens).toBe(8);
      for (const token of [3, 4]) {
        await onToken(token);
        seen.push(token);
      }
      return Uint32Array.from([3, 4]);
    });
    const tokens: string[] = [];
    const result = await generateWithModel(model, payload, (token) => {
      tokens.push(token);
    });

    expect(seen).toEqual([3, 4]);
    expect(tokens).toEqual(['こんにちは', 'こんにちは']);
    expect(model.generate).not.toHaveBeenCalled();
    expect(result).toEqual({ output: [{ generated_text: 'こんにちは' }] });
  });

  it('falls back to a single onToken event when wasm has no stream API', async () => {
    const model = fakeModel();
    const tokens: string[] = [];
    await generateWithModel(model, payload, (token) => {
      tokens.push(token);
    });
    expect(tokens).toEqual(['こんにちは']);
  });

  it('rejects sampling and non-PLaMO models', () => {
    expect(() => assertPlamoPayload({ ...payload, options: { do_sample: true } })).toThrow(
      /greedy/,
    );
    expect(() => assertPlamoPayload({ ...payload, model: 'other/model' })).toThrow(/pinned PLaMO/);
    expect(() => assertPlamoPayload({ ...payload, input: '' })).toThrow(/non-empty/);
    expect(() => assertPlamoPayload({ ...payload, options: { max_new_tokens: 0 } })).toThrow(
      /max_new_tokens/,
    );
  });
});
