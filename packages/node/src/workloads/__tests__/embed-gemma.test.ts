import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaEmbedGemma = vi.fn();

vi.mock('../friedflaxia/embed-gemma', () => ({
  handleFriedFlaxiaEmbedGemma: (...args: unknown[]) => handleFriedFlaxiaEmbedGemma(...args),
  releaseCache: () => {},
}));

import { handleEmbedGemma } from '../embed-gemma';

describe('embed-gemma workload', () => {
  beforeEach(() => handleFriedFlaxiaEmbedGemma.mockReset());

  it('forwards validated texts and dimensions', async () => {
    handleFriedFlaxiaEmbedGemma.mockResolvedValue({
      vectors: [[1, 0]],
      model: 'google/embeddinggemma-2',
      dimensions: 512,
      durationMs: 1,
    });
    const result = await handleEmbedGemma({ texts: ['a', 'b'], dimensions: 512 });
    expect(handleFriedFlaxiaEmbedGemma).toHaveBeenCalledWith({ texts: ['a', 'b'], dimensions: 512 }, undefined);
    expect(result.vectors).toHaveLength(1);
  });

  it('rejects empty, oversized or invalid payloads before loading a model', async () => {
    await expect(handleEmbedGemma({ texts: [] })).rejects.toThrow(/texts/);
    await expect(handleEmbedGemma({ texts: [''] })).rejects.toThrow(/non-empty/);
    await expect(handleEmbedGemma({ texts: ['x'.repeat(4001)] })).rejects.toThrow(/4000/);
    await expect(handleEmbedGemma({ texts: ['ok'], dimensions: 100 as any })).rejects.toThrow(/dimensions/);
    expect(handleFriedFlaxiaEmbedGemma).not.toHaveBeenCalled();
  });
});
