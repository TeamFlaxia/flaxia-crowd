import { describe, expect, it, vi } from 'vitest';
import { decideWithModel, type D1Model } from '../friedflaxia/decision';

const TOKENS: Record<string, number> = {
  '<|reserved_7|>': 10,
  '<|reserved_8|>': 11,
  '<|reserved_9|>': 12,
  '<|reserved_10|>': 13,
  '<|reserved_11|>': 14,
  '<|mask|>': 15,
};

function fakeModel(): D1Model {
  return {
    encode: vi.fn(() => Uint32Array.from([5, 6])),
    decision: vi.fn(() => Float32Array.from([0.1, 0.9])),
    token_id: vi.fn((token: string) => TOKENS[token]),
    bos_token_id: vi.fn(() => 1),
    metadata_f32: vi.fn(() => undefined),
    free: vi.fn(),
  };
}

const payload = {
  task: 'decision',
  model: 'LiquidAI/d1-omni-600M',
  engine: 'friedflaxia' as const,
  decision: {
    state: 'hello',
    questions: {
      q: {
        type: 'choice' as const,
        instructions: 'pick one',
        criteria: { a: 'A', b: 'B' },
      },
    },
  },
};

describe('friedflaxia d1 decision', () => {
  it('encodes prompts, scores markers and returns calibrated answers', async () => {
    const model = fakeModel();
    const result = await decideWithModel(model, payload);

    expect(model.decision).toHaveBeenCalledTimes(1);
    expect(result.answers?.q).toMatchObject({ choice: 'b' });
    expect(result.output).toMatchObject({
      answers: { q: { choice: 'b' } },
      usage: { output_tokens: 0 },
    });
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it('rejects media and non-d1 models', async () => {
    await expect(
      decideWithModel(fakeModel(), {
        ...payload,
        decision: {
          ...payload.decision,
          imageUrls: ['https://example.com/a.jpg'],
        },
      }),
    ).rejects.toThrow(/text-only/);

    await expect(
      decideWithModel(fakeModel(), { ...payload, model: 'other/model' }),
    ).rejects.toThrow(/d1-omni-600M/);
  });
});
