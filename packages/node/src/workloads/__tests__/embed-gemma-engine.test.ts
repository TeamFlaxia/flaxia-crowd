import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaEmbedGemma = vi.fn();
const releaseFriedFlaxiaCache = vi.fn();

vi.mock('../friedflaxia/embed-gemma', () => ({
  handleFriedFlaxiaEmbedGemma: (...args: unknown[]) => handleFriedFlaxiaEmbedGemma(...args),
  releaseCache: () => releaseFriedFlaxiaCache(),
}));

import { handleEmbedGemma, releaseCache } from '../embed-gemma';

describe('embed-gemma engine selection', () => {
  beforeEach(() => {
    handleFriedFlaxiaEmbedGemma.mockReset();
    releaseFriedFlaxiaCache.mockReset();
  });

  it('routes friedflaxia payloads to the GGUF backend', async () => {
    const expected = {
      vectors: [[0.1, 0.2]],
      model: 'google/embeddinggemma-2',
      dimensions: 256,
      durationMs: 1,
    };
    handleFriedFlaxiaEmbedGemma.mockResolvedValue(expected);

    const result = await handleEmbedGemma({
      texts: ['hello'],
      dimensions: 256,
      engine: 'friedflaxia',
    });

    expect(handleFriedFlaxiaEmbedGemma).toHaveBeenCalledWith(
      { texts: ['hello'], dimensions: 256 },
      undefined,
    );
    expect(result).toBe(expected);
  });

  it('releases both engine caches', () => {
    releaseCache();
    expect(releaseFriedFlaxiaCache).toHaveBeenCalledTimes(1);
  });
});
