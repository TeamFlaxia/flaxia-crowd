import { describe, expect, it, vi } from 'vitest';
import { MAX_EMBED_GEMMA_TOKENS } from '@flaxia/sdk';
import {
  embedTexts,
  limitTokenIds,
  truncateAndNormalize,
  type FriedFlaxiaModel,
} from '../friedflaxia/embed-gemma';

function fakeModel(embedding: Float32Array): FriedFlaxiaModel {
  return {
    encode: vi.fn(() => Uint32Array.from([2, 3689, 1])),
    embed: vi.fn(() => embedding),
    free: vi.fn(),
  };
}

function unitEmbedding(): Float32Array {
  const values = new Float32Array(768);
  values[0] = 0.6;
  values[1] = 0.8;
  return values;
}

describe('friedflaxia embed-gemma', () => {
  it('encodes with special tokens and returns normalized Matryoshka vectors', async () => {
    const model = fakeModel(unitEmbedding());
    const vectors = await embedTexts(model, ['hello', 'world'], 2);

    expect(model.encode).toHaveBeenCalledWith('hello', true);
    expect(model.encode).toHaveBeenCalledWith('world', true);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector[0]).toBeCloseTo(0.6, 6);
      expect(vector[1]).toBeCloseTo(0.8, 6);
    }
  });

  it('truncates and re-normalizes the native vector', () => {
    expect(truncateAndNormalize([3, 4, 12], 2)).toEqual([0.6, 0.8]);
    expect(truncateAndNormalize([0, 0], 2)).toEqual([0, 0]);
  });

  it('rejects a model with the wrong embedding width', async () => {
    const model = fakeModel(new Float32Array(4));
    await expect(embedTexts(model, ['hello'], 2)).rejects.toThrow(/expected 768/);
  });

  it('calls the batch yield callback', async () => {
    const onBatch = vi.fn();
    await embedTexts(fakeModel(unitEmbedding()), ['hello'], 768, onBatch);
    expect(onBatch).toHaveBeenCalledTimes(1);
  });

  it('caps a sequence at the token budget and restores EOS', async () => {
    const ids = new Uint32Array(10);
    for (let index = 0; index < ids.length; index += 1) ids[index] = index + 3;
    const limited = limitTokenIds(ids, 1, 4);
    expect(Array.from(limited)).toEqual([3, 4, 5, 1]);
    expect(limitTokenIds(ids, 1, 10)).toBe(ids);
  });

  it('truncates before calling the encoder', async () => {
    const model = fakeModel(unitEmbedding());
    model.encode = vi.fn(() => new Uint32Array(MAX_EMBED_GEMMA_TOKENS + 10).fill(7));
    model.eos_token_id = () => 1;
    await embedTexts(model, ['long'], 768);
    const passed = (model.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint32Array;
    expect(passed.length).toBe(MAX_EMBED_GEMMA_TOKENS);
    expect(passed[passed.length - 1]).toBe(1);
  });
});
