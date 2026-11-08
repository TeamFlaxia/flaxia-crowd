import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { wasm: {} as Record<string, unknown> } } },
  pipeline: vi.fn(),
  AutoModel: { from_pretrained: vi.fn() },
  loadImage: vi.fn(),
  TextStreamer: class {},
}));

// Importing modules registers single-threaded wasm config; we only exercise
// the pure validation/normalisation helpers here (no model load).
import { handleDecision, normalizeDecisionAnswer } from '../decision';
import { buildInterleavedText } from '../vector-embed';

describe('decision payload validation', () => {
  it('rejects images and audio in one call (model limit)', async () => {
    await expect(
      handleDecision({
        decision: {
          state: '今日はレトロゲーム会',
          questions: {
            trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
          },
          imageUrls: ['https://example.com/a.png'],
          audioUrl: 'https://example.com/a.wav',
        },
      }),
    ).rejects.toThrow(/images or audio/);
  });

  it('rejects non-https media URLs', async () => {
    await expect(
      handleDecision({
        decision: {
          state: 'x',
          questions: {
            trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
          },
          imageUrls: ['http://example.com/a.png'],
        },
      }),
    ).rejects.toThrow(/https/);
  });

  it('rejects empty questions and null state without media', async () => {
    await expect(handleDecision({ decision: { state: 'x', questions: {} } })).rejects.toThrow(/questions/);
    await expect(
      handleDecision({
        decision: {
          state: null,
          questions: { trend: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } },
        },
      }),
    ).rejects.toThrow(/needs at least one image/);
  });

  it('requires criteria for choice and levels for score', async () => {
    await expect(
      handleDecision({
        decision: { state: 'x', questions: { trend: { type: 'choice', instructions: 'x' } } },
      }),
    ).rejects.toThrow(/criteria/);
    await expect(
      handleDecision({
        decision: { state: 'x', questions: { urgency: { type: 'score', instructions: 'x' } } },
      }),
    ).rejects.toThrow(/levels/);
  });
});

describe('decision answer normalisation', () => {
  it('passes through probabilities for Top-K hosts', () => {
    const answer = normalizeDecisionAnswer({
      choice: 'game',
      confidence: 0.8,
      probabilities: { game: 0.8, music: 0.15, none: 0.05 },
    });
    expect(answer.choice).toBe('game');
    expect(answer.confidence).toBeCloseTo(0.8);
    expect(answer.probabilities).toEqual({ game: 0.8, music: 0.15, none: 0.05 });
  });

  it('drops non-numeric probabilities and accepts raw probs alias', () => {
    const answer = normalizeDecisionAnswer({
      choice: 'a',
      probs: { a: 'high', b: 0.3 },
    });
    expect(answer.probabilities).toEqual({ b: 0.3 });
  });

  it('maps noul to P(yes)', () => {
    expect(normalizeDecisionAnswer({ noul: 0.72 }).noul).toBeCloseTo(0.72);
  });
});

describe('vector-embed multimodal helpers', () => {
  it('appends missing placeholders without duplicating existing ones', () => {
    const out = buildInterleavedText('今日の写真 <|image|>', { images: 2, videos: 0, audio: 0 });
    expect(out.split('<|image|>').length - 1).toBe(2);
    expect(buildInterleavedText('x', { images: 0, videos: 1, audio: 1 })).toContain('<|video|>');
    expect(buildInterleavedText('x', { images: 0, videos: 1, audio: 1 })).toContain('<|audio|>');
  });
});

describe('decision worked-example flow (mocked model)', () => {
  it('answers Top-3 probabilities across text+image state in one pass', async () => {
    const fakeModel = {
      system_one: vi.fn((state: unknown, questions: unknown) => {
        // The workload module passes (state, questions, {images, audio}).
        const questionsObj = questions as Record<
          string,
          { type: string; criteria: Record<string, string> }
        >;
        const criteria = questionsObj.trend.criteria;
        const answers: Record<string, unknown> = {
          trend: {
            choice: 'game',
            confidence: 0.62,
            probabilities: {
              game: 0.62,
              music: 0.18,
              food: 0.05,
              none: 0.15,
            },
          },
        };
        // Echo back the option order the caller supplied (ensures no option was dropped).
        for (const option of Object.keys(criteria)) {
          (answers.trend.probabilities as Record<string, number>)[option] ??= 0.01;
        }
        return { answers, usage: { input_tokens: 128, output_tokens: 0 } };
      }),
    };
    const transformers = (await import('@huggingface/transformers')) as unknown as {
      loadImage: ReturnType<typeof vi.fn>;
    };
    transformers.loadImage.mockResolvedValue({ fake: 'image' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
    }) as unknown as typeof fetch;
    try {
      const { AutoModel } = (await import('@huggingface/transformers')) as unknown as {
        AutoModel: { from_pretrained: ReturnType<typeof vi.fn> };
      };
      AutoModel.from_pretrained.mockResolvedValue(fakeModel);

      // Re-import decision module fresh so its cached model resets between tests:
      // decisionLoadPromise is module-scoped, so release it and re-resolve.
      const decisionModule = await import('../decision');
      decisionModule.releaseCache();
      AutoModel.from_pretrained.mockResolvedValue(fakeModel);

      const result = await decisionModule.handleDecision({
        decision: {
          state: '今日はレトロゲーム会で盛り上がった',
          questions: {
            trend: {
              type: 'choice',
              instructions: 'この投稿の話題として当てはまるタグを選んでください（該当なしなら none）。',
              criteria: { game: 'game', music: 'music', food: 'food', none: 'none' },
            },
          },
          imageUrls: ['https://example.com/photo.png'],
        },
      });

      expect(fakeModel.system_one).toHaveBeenCalledTimes(1);
      expect(result.answers?.trend.choice).toBe('game');
      expect(result.answers?.trend.probabilities?.game).toBeCloseTo(0.62);
      expect(result.answers?.trend.probabilities?.none).toBeCloseTo(0.15);
      expect(result.inputTokens).toBe(128);
      expect(result.durationMs).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
