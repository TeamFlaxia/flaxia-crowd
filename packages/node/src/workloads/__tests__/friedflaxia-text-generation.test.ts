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
