import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaTextGeneration = vi.fn();
const releaseFriedFlaxiaTextGeneration = vi.fn();

vi.mock('../friedflaxia/text-generation', () => ({
  handleFriedFlaxiaTextGeneration: (...args: unknown[]) =>
    handleFriedFlaxiaTextGeneration(...args),
  releaseCache: () => releaseFriedFlaxiaTextGeneration(),
}));

vi.mock('@huggingface/transformers', () => ({
  env: { backends: {} },
  pipeline: vi.fn(),
  TextStreamer: class {},
}));

import { handleAiInference, releaseCache } from '../ai-inference';
import { FRIEDFLAXIA_PLAMO } from '../friedflaxia/model-registry';

describe('ai-inference FriedFlaxia routing', () => {
  beforeEach(() => {
    handleFriedFlaxiaTextGeneration.mockReset();
    releaseFriedFlaxiaTextGeneration.mockReset();
  });

  it('routes text-generation with engine=friedflaxia to the PLaMO backend', async () => {
    const expected = { output: [{ generated_text: 'こんにちは' }] };
    handleFriedFlaxiaTextGeneration.mockResolvedValue(expected);

    const result = await handleAiInference({
      task: 'text-generation',
      model: FRIEDFLAXIA_PLAMO.modelId,
      input: 'Hello world',
      engine: 'friedflaxia',
    });

    expect(handleFriedFlaxiaTextGeneration).toHaveBeenCalledTimes(1);
    expect(result).toBe(expected);
  });

  it('releases the FriedFlaxia cache with the pipeline cache', () => {
    releaseCache();
    expect(releaseFriedFlaxiaTextGeneration).toHaveBeenCalledTimes(1);
  });
});
