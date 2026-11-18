import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaEmbedGemma = vi.fn();
const releaseFriedFlaxiaCache = vi.fn();

vi.mock('../friedflaxia/embed-gemma', () => ({
  handleFriedFlaxiaEmbedGemma: (...args: unknown[]) => handleFriedFlaxiaEmbedGemma(...args),
  releaseCache: () => releaseFriedFlaxiaCache(),
}));

import { handleVectorEmbed, releaseCache } from '../vector-embed';

describe('vector-embed engine selection', () => {
  beforeEach(() => {
    handleFriedFlaxiaEmbedGemma.mockReset();
    releaseFriedFlaxiaCache.mockReset();
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

  it('rejects multimodal friedflaxia payloads instead of silently changing engines', async () => {
    await expect(
      handleVectorEmbed({
        text: 'hello',
        imageUrls: ['https://example.com/a.jpg'],
        engine: 'friedflaxia',
      }),
    ).rejects.toThrow(/text-only/);
    expect(handleFriedFlaxiaEmbedGemma).not.toHaveBeenCalled();
  });

  it('releases both engine caches', () => {
    releaseCache();
    expect(releaseFriedFlaxiaCache).toHaveBeenCalledTimes(1);
  });
});
