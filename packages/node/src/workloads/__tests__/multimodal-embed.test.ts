import { describe, expect, it } from 'vitest';
import { MAX_EMBED_GEMMA_TOKENS } from '@flaxia/sdk';
import { buildMultimodalTokenIds, type MultimodalWasmModel } from '../friedflaxia/multimodal-embed';

function fakeModel(): MultimodalWasmModel {
  return {
    encode: (text: string) => Uint32Array.from(Array.from(text, (char) => char.charCodeAt(0))),
    encode_image: () => new Float32Array(0),
    encode_audio: () => new Float32Array(0),
    embed: () => new Float32Array(0),
    bos_token_id: () => 2,
    eos_token_id: () => 1,
    free: () => {},
  };
}

describe('multimodal token construction', () => {
  it('expands image and audio placeholders in order', () => {
    const ids = buildMultimodalTokenIds(fakeModel(), 'a<|image|>b<|audio|>c', {
      image: [3],
      audio: [2],
      video: [],
    });
    expect(Array.from(ids)).toEqual([
      2,
      97,
      255999, 258880, 258880, 258880, 258882,
      98,
      256000, 258881, 258881, 258883,
      99,
      1,
    ]);
  });

  it('expands a video placeholder once per sampled frame', () => {
    const ids = buildMultimodalTokenIds(fakeModel(), 'a<|video|>b', {
      image: [],
      audio: [],
      video: [{ tokens: 2, frames: 3 }],
    });
    expect(Array.from(ids)).toEqual([
      2,
      97,
      255999, 258884, 258884, 258882,
      255999, 258884, 258884, 258882,
      255999, 258884, 258884, 258882,
      98,
      1,
    ]);
  });

  it('rejects placeholder/media mismatches', () => {
    expect(() =>
      buildMultimodalTokenIds(fakeModel(), 'x<|image|>', { image: [], audio: [], video: [] }),
    ).toThrow(/missing image/);
    expect(() =>
      buildMultimodalTokenIds(fakeModel(), 'x', { image: [1], audio: [], video: [] }),
    ).toThrow(/image media count/);
  });

  it('bounds the sequence and drops a media block that does not fit', () => {
    const ids = buildMultimodalTokenIds(fakeModel(), `${'x'.repeat(3_000)}<|image|>y`, {
      image: [280],
      audio: [],
      video: [],
    });
    expect(ids.length).toBe(MAX_EMBED_GEMMA_TOKENS);
    expect(ids[ids.length - 1]).toBe(1);
    // The image block starts past the budget, so it is dropped whole.
    expect(Array.from(ids).filter((id) => id === 258880)).toHaveLength(0);
  });

  it('keeps a media block that fits and cuts only trailing text', () => {
    const ids = buildMultimodalTokenIds(fakeModel(), `a<|image|>${'y'.repeat(3_000)}`, {
      image: [280],
      audio: [],
      video: [],
    });
    expect(ids.length).toBe(MAX_EMBED_GEMMA_TOKENS);
    expect(ids[ids.length - 1]).toBe(1);
    expect(Array.from(ids).filter((id) => id === 258880)).toHaveLength(280);
  });
});
