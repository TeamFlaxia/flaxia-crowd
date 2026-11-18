import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleFriedFlaxiaTextGeneration = vi.fn();
const releaseFriedFlaxiaTextGeneration = vi.fn();
const handleFriedFlaxiaDecision = vi.fn();
const releaseFriedFlaxiaDecision = vi.fn();

vi.mock('../friedflaxia/text-generation', () => ({
  handleFriedFlaxiaTextGeneration: (...args: unknown[]) => handleFriedFlaxiaTextGeneration(...args),
  releaseCache: () => releaseFriedFlaxiaTextGeneration(),
  loadFriedFlaxiaPlamo: async () => ({}),
}));

vi.mock('../friedflaxia/decision', () => ({
  handleFriedFlaxiaDecision: (...args: unknown[]) => handleFriedFlaxiaDecision(...args),
  releaseCache: () => releaseFriedFlaxiaDecision(),
  loadFriedFlaxiaD1: async () => ({}),
}));

import { handleAiInference, releaseCache } from '../ai-inference';

describe('ai-inference FriedFlaxia routing', () => {
  beforeEach(() => {
    handleFriedFlaxiaTextGeneration.mockReset();
    releaseFriedFlaxiaTextGeneration.mockReset();
    handleFriedFlaxiaDecision.mockReset();
    releaseFriedFlaxiaDecision.mockReset();
  });

  it('routes text-generation to the PLaMO backend', async () => {
    const expected = { output: [{ generated_text: 'こんにちは' }] };
    handleFriedFlaxiaTextGeneration.mockResolvedValue(expected);
    const result = await handleAiInference({
      task: 'text-generation',
      model: 'TeamFlaxia/plamo-3-translate-0.8b-onnx',
      input: 'Hello world',
    } as any);
    expect(handleFriedFlaxiaTextGeneration).toHaveBeenCalledTimes(1);
    expect(result).toBe(expected);
  });

  it('routes decision payloads to the d1 backend', async () => {
    const expected = { output: { answers: {} }, answers: {}, inputTokens: 3 };
    handleFriedFlaxiaDecision.mockResolvedValue(expected);
    const result = await handleAiInference({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'hello', questions: { q: { type: 'noul', instructions: 'is it true?' } } },
    } as any);
    expect(handleFriedFlaxiaDecision).toHaveBeenCalledTimes(1);
    expect(result).toBe(expected);
  });

  it('releases both FriedFlaxia caches', () => {
    releaseCache();
    expect(releaseFriedFlaxiaTextGeneration).toHaveBeenCalledTimes(1);
    expect(releaseFriedFlaxiaDecision).toHaveBeenCalledTimes(1);
  });
});
