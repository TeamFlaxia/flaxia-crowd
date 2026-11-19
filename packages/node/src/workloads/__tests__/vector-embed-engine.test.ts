import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaEmbedGemma = vi.fn();
const releaseFriedFlaxiaCache = vi.fn();
const handleFriedFlaxiaVectorEmbed = vi.fn();
const releaseFriedFlaxiaMultimodalCache = vi.fn();

vi.mock('../friedflaxia/embed-gemma', () => ({
  handleFriedFlaxiaEmbedGemma: (...args: unknown[]) => handleFriedFlaxiaEmbedGemma(...args),
  releaseCache: () => releaseFriedFlaxiaCache(),
}));

vi.mock('../friedflaxia/multimodal-embed', () => ({
  handleFriedFlaxiaVectorEmbed: (...args: unknown[]) => handleFriedFlaxiaVectorEmbed(...args),
  releaseCache: () => releaseFriedFlaxiaMultimodalCache(),
}));

import { handleVectorEmbed, releaseCache } from '../vector-embed';

describe('vector-embed engine selection', () => {
  beforeEach(() => {
    handleFriedFlaxiaEmbedGemma.mockReset();
    releaseFriedFlaxiaCache.mockReset();
    handleFriedFlaxiaVectorEmbed.mockReset();
    releaseFriedFlaxiaMultimodalCache.mockReset();
  });

  it('routes text-only friedflaxia payloads to the GGUF backend', async () => {
    handleFriedFlaxiaEmbedGemma.mockResolvedValue({
      vectors: [[0.1, 0.2, 0.3]],
      model: 'google/embeddinggemma-2',
      dimensions: 768,
      durationMs: 1,
    });

    const result = await handleVectorEmbed({
      text: 'hello',
      engine: 'friedflaxia',
    });

    expect(handleFriedFlaxiaEmbedGemma).toHaveBeenCalledWith({
      texts: ['hello'],
      dimensions: 768,
    });
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimensions).toBe(768);
    expect(result.model).toBe('onnx-community/embeddinggemma-2-ONNX');
  });

  it('routes multimodal friedflaxia payloads to the wasm multimodal backend', async () => {
    handleFriedFlaxiaVectorEmbed.mockResolvedValue({
      vector: [0.4, 0.5],
      durationMs: 2,
    });

    const result = await handleVectorEmbed({
      text: 'a photo',
      imageUrls: ['https://example.com/a.jpg'],
      engine: 'friedflaxia',
    });

    expect(handleFriedFlaxiaVectorEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'friedflaxia' }),
      'a photo <|image|>',
      ['https://example.com/a.jpg'],
      undefined,
      undefined,
    );
    expect(result.vector).toEqual([0.4, 0.5]);
    expect(handleFriedFlaxiaEmbedGemma).not.toHaveBeenCalled();
  });

  it('routes video payloads to the multimodal backend', async () => {
    handleFriedFlaxiaVectorEmbed.mockResolvedValue({ vector: [0.7], durationMs: 3 });
    const result = await handleVectorEmbed({
      text: 'a clip',
      videoUrl: 'https://example.com/a.mp4',
      engine: 'friedflaxia',
    });
    expect(handleFriedFlaxiaVectorEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ videoUrl: 'https://example.com/a.mp4' }),
      'a clip <|video|>',
      [],
      undefined,
      'https://example.com/a.mp4',
    );
    expect(result.vector).toEqual([0.7]);
  });

  it('releases both FriedFlaxia caches', () => {
    releaseCache();
    expect(releaseFriedFlaxiaCache).toHaveBeenCalledTimes(1);
    expect(releaseFriedFlaxiaMultimodalCache).toHaveBeenCalledTimes(1);
  });
});
