import { describe, it, expect, vi } from 'vitest';

const handleFriedFlaxiaTextGeneration = vi.fn(async () => ({ output: [{ generated_text: 'ok' }] }));
const handleFriedFlaxiaDecision = vi.fn(async () => ({ output: { answers: {} } }));

vi.mock('../friedflaxia/text-generation', () => ({
  handleFriedFlaxiaTextGeneration: (...args: unknown[]) => handleFriedFlaxiaTextGeneration(...(args as [])),
  releaseCache: () => {},
  loadFriedFlaxiaPlamo: async () => ({}),
}));

vi.mock('../friedflaxia/decision', () => ({
  handleFriedFlaxiaDecision: (...args: unknown[]) => handleFriedFlaxiaDecision(...(args as [])),
  releaseCache: () => {},
  loadFriedFlaxiaD1: async () => ({}),
}));

import { handleAiInference } from '../ai-inference';

describe('AI Inference Workload', () => {
  it('routes text-generation to the PLaMO backend', async () => {
    await handleAiInference({ task: 'text-generation', model: 'TeamFlaxia/plamo-3-translate-0.8b-onnx', input: 'hello' } as any);
    expect(handleFriedFlaxiaTextGeneration).toHaveBeenCalledTimes(1);
  });

  it('routes decision payloads to the d1 backend', async () => {
    await handleAiInference({
      task: 'decision',
      model: 'LiquidAI/d1-omni-600M',
      decision: { state: 'hello', questions: { q: { type: 'noul', instructions: 'true?' } } },
    } as any);
    expect(handleFriedFlaxiaDecision).toHaveBeenCalledTimes(1);
  });

  it('rejects tasks that no longer have an ONNX fallback', async () => {
    await expect(
      handleAiInference({ task: 'text-classification', model: 'x/y', input: 'test' } as any),
    ).rejects.toThrow(/Invalid or unsupported task/);
  });

  it('lists the reduced task set in the error', async () => {
    try {
      await handleAiInference({ task: 'image-to-text', model: 'x/y', input: 'test' } as any);
      expect.unreachable();
    } catch (error: any) {
      expect(error.message).toContain('text-generation');
      expect(error.message).toContain('decision');
    }
  });
});
