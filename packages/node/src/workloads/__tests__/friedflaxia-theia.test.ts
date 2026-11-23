import { describe, expect, it, vi } from 'vitest';
import type { TheiaCanvas, TheiaInferencePayload } from '@flaxia/sdk';
import type { DllmModel, DllmTopKOutput } from '../../vendor/friedflaxia/types';
import {
  THEIA_MAX_CONTEXT_TOKENS,
  buildChatTokens,
  decodeSpan,
  runTheiaInference,
  tokenizeCanvas,
} from '../friedflaxia/theia';
import { handleTheiaInference } from '../theia';

function fakeModel(options: { outputToken?: number; eos?: number[] } = {}): DllmModel & {
  denoise_topk: ReturnType<typeof vi.fn>;
} {
  const outputToken = options.outputToken ?? 88; // 'X'
  const specials: Record<string, number> = {
    '<|im_start|>': 1,
    '<|im_end|>': 2,
    '<|mask|>': 3,
    '<|endoftext|>': 4,
  };
  const denoise_topk = vi.fn(
    (
      _tokens: Uint32Array | number[],
      positions: Uint32Array | number[],
      _blockStart: number,
      _blockEnd: number,
      topK: number,
    ): DllmTopKOutput => {
      const rows = Array.from(positions as number[]);
      const tokenIds: number[] = [];
      const probabilities: number[] = [];
      for (const _row of rows) {
        for (let index = 0; index < topK; index += 1) {
          tokenIds.push(index === 0 ? outputToken : 0);
          probabilities.push(index === 0 ? 0.9 : 0.1 / Math.max(1, topK - 1));
        }
      }
      return {
        positions: rows,
        tokenIds,
        probabilities,
        confidence: rows.map(() => 0.9),
        vocabSize: 200,
        topK,
      };
    },
  );
  return {
    encode: vi.fn((text: string) => Uint32Array.from(Array.from(text, (c) => c.codePointAt(0) ?? 0))),
    decode: vi.fn((ids: Uint32Array | number[]) =>
      Array.from(ids as number[])
        .filter((id) => id !== 1 && id !== 2 && id !== 3 && id !== 4)
        .map((id) => String.fromCodePoint(id))
        .join(''),
    ),
    token_id: vi.fn((token: string) => specials[token]),
    eos_token_id: vi.fn(() => (options.eos ? options.eos[0] : undefined)),
    free: vi.fn(),
    loraRank: vi.fn(() => undefined),
    loraExpert: vi.fn(() => undefined),
    denoise_topk,
  } as never;
}

function canvas(overrides: Partial<TheiaCanvas> = {}): TheiaCanvas {
  return {
    version: 3,
    text: '____ and ____',
    spans: [
      { id: 'a', start: 0, end: 4, open: true },
      { id: 'b', start: 9, end: 13, open: true },
    ],
    ...overrides,
  };
}

function payload(overrides: Partial<TheiaInferencePayload> = {}): TheiaInferencePayload {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'qwen3-0.6b-diffusion-bd3lm',
    phase: 'denoise',
    canvas: canvas(),
    round: 2,
    ...overrides,
  };
}

describe('theia canvas tokenization', () => {
  it('maps each span to its token range without crossing boundaries', () => {
    const model = fakeModel();
    const tokenized = tokenizeCanvas(model, canvas());
    expect(tokenized.spans.map(({ start, end }) => [start, end])).toEqual([
      [0, 4],
      [9, 13],
    ]);
    expect(tokenized.tokens.length).toBe(canvas().text.length);
  });
});

describe('theia span decoding', () => {
  it('ignores a leading EOS but stops at the first EOS after content', () => {
    const model = fakeModel();
    // eos=2, output=88 ('X'): leading EOS is padding, the final EOS ends the span.
    expect(decodeSpan(model, [2, 88, 88, 2, 88], 0, 5, 2)).toBe('XX');
    expect(decodeSpan(model, [2, 2, 2], 0, 3, 2)).toBe('');
  });
});

describe('theia executor', () => {
  it('denoises every open span and returns replace deltas', async () => {
    const model = fakeModel();
    const result = await runTheiaInference(model, payload());
    expect(result.phase).toBe('denoise');
    expect(result.canvasVersion).toBe(3);
    expect(result.round).toBe(2);
    expect(result.deltas).toHaveLength(2);
    expect(result.deltas?.[0]).toMatchObject({
      expert: 'base',
      baseVersion: 3,
      round: 2,
      ops: [{ kind: 'replace', span: [0, 4], text: 'XXXX' }],
    });
    expect(result.deltas?.[0].confidence).toBeCloseTo(0.9, 6);
    // The last span in a block may grow into the generated tail.
    expect(result.deltas?.[1].ops[0]).toMatchObject({ span: [9, 13] });
    expect((result.deltas?.[1].ops[0].text ?? '').startsWith('XXXX')).toBe(true);
    // One call per span per step (two masks committed per step by default).
    expect(model.denoise_topk).toHaveBeenCalled();
  });

  it('skips a committed span', async () => {
    const model = fakeModel();
    const result = await runTheiaInference(
      model,
      payload({
        canvas: canvas({
          spans: [
            { id: 'a', start: 0, end: 4, open: false },
            { id: 'b', start: 9, end: 13, open: true },
          ],
        }),
      }),
    );
    expect(result.deltas).toHaveLength(1);
    expect(result.deltas?.[0].ops[0].span).toEqual([9, 13]);
  });

  it('generates a response within the token budget', async () => {
    const model = fakeModel({ outputToken: 88, eos: [2] });
    const result = await runTheiaInference(
      model,
      payload({ phase: 'generate', canvas: undefined, maxNewTokens: 4, steps: 2 }),
    );
    expect(result.phase).toBe('generate');
    expect(result.output).toBe('XXXX');
    expect(result.steps).toBe(2);
  });

  it('rejects an expert that is not loaded', async () => {
    const model = fakeModel();
    await expect(runTheiaInference(model, payload({ expert: 'code' }))).rejects.toThrow(
      /not distributed yet/,
    );
  });

  it('rejects a canvas that does not fit the context', async () => {
    const model = fakeModel();
    const long = 'x'.repeat(THEIA_MAX_CONTEXT_TOKENS);
    await expect(
      runTheiaInference(
        model,
        payload({
          messages: [{ role: 'user', content: 'hi' }],
          canvas: canvas({ text: long, spans: [{ id: 'a', start: 0, end: long.length, open: true }] }),
        }),
      ),
    ).rejects.toThrow(/exceed/);
  });

  it('builds a Qwen chat prompt with a generation marker', () => {
    const model = fakeModel();
    const ids = buildChatTokens(model, [{ role: 'user', content: 'hi' }], true);
    expect(ids[0]).toBe(1);
    expect(ids).toContain(2);
    expect(ids[ids.length - 1]).not.toBe(2);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe('theia workload wrapper', () => {
  it('rejects a denoise payload without a canvas', async () => {
    await expect(
      handleTheiaInference({ messages: [{ role: 'user', content: 'hi' }], model: 'm', phase: 'denoise' }),
    ).rejects.toThrow(/invalid payload/);
  });

  it('runs against an injected model', async () => {
    const model = fakeModel();
    const result = await handleTheiaInference(payload(), undefined, model);
    expect(result.deltas).toHaveLength(2);
  });
});
