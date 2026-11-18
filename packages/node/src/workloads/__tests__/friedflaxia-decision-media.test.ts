import { describe, expect, it, vi } from 'vitest';

vi.mock('../friedflaxia/d1-preprocess', () => ({
  fetchD1Image: vi.fn(async () => ({
    image: { patches: new Float32Array(0), grid: 32 },
    rows: 256,
  })),
  fetchD1Audio: vi.fn(async () => new Float32Array(16000)),
}));

import { decideWithMedia, type D1MultimodalWasmModel } from '../friedflaxia/decision';

const TOKENS: Record<string, number> = {
  '<|reserved_7|>': 10,
  '<|reserved_8|>': 11,
  '<|reserved_9|>': 12,
  '<|reserved_10|>': 13,
  '<|reserved_11|>': 14,
  '<|mask|>': 15,
};

function fakeModel(audioRows = 13): D1MultimodalWasmModel {
  return {
    encode: () => Uint32Array.from([5, 6]),
    token_id: (token: string) => TOKENS[token],
    bos_token_id: () => 1,
    metadata_f32: () => undefined,
    encode_image: vi.fn(() => new Float32Array(256 * 1024)),
    encode_audio: () => new Float32Array(audioRows * 1024),
    decision: vi.fn(() => Float32Array.from([0.9, 0.1])),
    free: () => {},
  };
}

const payload = {
  task: 'decision',
  model: 'LiquidAI/d1-omni-600M',
  engine: 'friedflaxia' as const,
  decision: {
    state: null,
    questions: {
      q: {
        type: 'noul' as const,
        instructions: 'is this allowed?',
      },
    },
  },
};

describe('friedflaxia d1 media decision', () => {
  it('encodes images and prepends their soft tokens', async () => {
    const model = fakeModel();
    const result = await decideWithMedia(model, {
      ...payload,
      decision: { ...payload.decision, imageUrls: ['https://example.com/a.jpg'] },
    } as any);
    expect(model.encode_image).toHaveBeenCalled();
    const call = (model.decision as any).mock.calls[0];
    expect(call[3]).toHaveLength(256 * 1024);
    expect(call[4]).toBe(256);
    expect(result.answers?.q).toHaveProperty('noul');
    expect(result.inputTokens).toBeGreaterThan(256);
  });

  it('encodes audio and uses the audio prompt mode', async () => {
    const model = fakeModel(13);
    await decideWithMedia(model, {
      ...payload,
      decision: { ...payload.decision, audioUrl: 'https://example.com/a.mp3' },
    } as any);
    const call = (model.decision as any).mock.calls[0];
    expect(call[3]).toHaveLength(13 * 1024);
    expect(call[4]).toBe(13);
  });
});
