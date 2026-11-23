import { describe, expect, it, vi } from 'vitest';
import type { TheiaCanvas, TheiaInferencePayload } from '@flaxia/sdk';
import { MAX_THEIA_RESULT_DELTAS, THEIA_DLLM_MODEL_ID } from '@flaxia/sdk';
import type { DllmModel, DllmTopKOutput } from '../../vendor/friedflaxia/types';
import {
  THEIA_MAX_CONTEXT_TOKENS,
  buildChatTokens,
  decodeSpan,
  runTheiaInference,
  tokenizeCanvas,
} from '../friedflaxia/theia';
import { handleTheiaInference } from '../theia';
import { DLLM_MODEL_ID } from '../friedflaxia/dllm';

const SPECIALS: Record<string, number> = {
  '<|im_start|>': 1,
  '<|im_end|>': 2,
  '<|mask|>': 3,
  '<|endoftext|>': 4,
};

function fakeModel(options: { outputToken?: number; loraExpert?: string } = {}): DllmModel & {
  denoise_topk: ReturnType<typeof vi.fn>;
} {
  const outputToken = options.outputToken ?? 88; // 'X'
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
        .filter((id) => !Object.values(SPECIALS).includes(id))
        .map((id) => String.fromCodePoint(id))
        .join(''),
    ),
    token_id: vi.fn((token: string) => SPECIALS[token]),
    eos_token_id: vi.fn(() => undefined),
    free: vi.fn(),
    loraRank: vi.fn(() => undefined),
    loraExpert: vi.fn(() => options.loraExpert),
    denoise_topk,
  } as never;
}

/** A word-level tokenizer, for spans that fall inside a token. */
function wordModel(): DllmModel {
  const ids = new Map<string, number>();
  const pieces = new Map<number, string>();
  let next = 10;
  const tokenFor = (word: string): number => {
    if (!ids.has(word)) {
      ids.set(word, next);
      pieces.set(next, word);
      next += 1;
    }
    return ids.get(word)!;
  };
  return {
    encode: vi.fn((text: string) =>
      Uint32Array.from(text.split(/(\s+)/).filter(Boolean).map(tokenFor)),
    ),
    decode: vi.fn((value: Uint32Array | number[]) =>
      Array.from(value as number[]).map((id) => pieces.get(id) ?? '').join(''),
    ),
    token_id: vi.fn((token: string) => SPECIALS[token]),
    eos_token_id: vi.fn(() => undefined),
    free: vi.fn(),
    loraRank: vi.fn(() => undefined),
    loraExpert: vi.fn(() => undefined),
    denoise_topk: vi.fn(() => ({
      positions: [],
      tokenIds: [],
      probabilities: [],
      confidence: [],
      vocabSize: 200,
      topK: 1,
    })),
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

describe('theia model pinning', () => {
  it('keeps the SDK warm id and the manifest id identical', () => {
    expect(DLLM_MODEL_ID).toBe(THEIA_DLLM_MODEL_ID);
  });
});

describe('theia canvas tokenization', () => {
  it('maps each span to its token range without crossing boundaries', () => {
    const tokenized = tokenizeCanvas(fakeModel(), canvas());
    expect(tokenized.spans.map(({ start, end }) => [start, end])).toEqual([
      [0, 4],
      [9, 13],
    ]);
    expect(tokenized.tokens.length).toBe(canvas().text.length);
  });

  it('rejects a span that falls inside one token', () => {
    const model = wordModel();
    expect(() =>
      tokenizeCanvas(model, {
        version: 0,
        text: 'prefix foobar',
        spans: [{ id: 'a', start: 7, end: 10, open: true }],
      }),
    ).toThrow(/token boundary/);
  });

  it('rejects an open span over the 512-character replacement limit', () => {
    const text = 'x'.repeat(513);
    expect(() =>
      tokenizeCanvas(fakeModel(), {
        version: 0,
        text,
        spans: [{ id: 'a', start: 0, end: 513, open: true }],
      }),
    ).toThrow(/limited to 512/);
  });

  it('rejects an open span with boundary whitespace', () => {
    expect(() =>
      tokenizeCanvas(fakeModel(), {
        version: 0,
        text: 'Hello ____ world',
        spans: [{ id: 'a', start: 5, end: 11, open: true }],
      }),
    ).toThrow(/leading\/trailing whitespace/);
  });

  it('ignores a closed span that falls inside a token', () => {
    const tokenized = tokenizeCanvas(wordModel(), {
      version: 0,
      text: 'foo bar baz',
      spans: [
        { id: 'closed', start: 3, end: 4, open: false },
        { id: 'open', start: 8, end: 11, open: true },
      ],
    });
    expect(tokenized.spans.map(({ span }) => span.id)).toEqual(['open']);
    expect(tokenized.spans[0]).toMatchObject({ start: 4, end: 5 });
  });

  it('rejects a canvas with a control token', () => {
    expect(() =>
      tokenizeCanvas(fakeModel(), {
        version: 0,
        text: '<|im_start|>system',
        spans: [{ id: 'a', start: 0, end: 14, open: true }],
      }),
    ).toThrow(/control tokens/);
  });
});

describe('theia span decoding', () => {
  it('ignores a leading EOS but stops at the first EOS after content', () => {
    const model = fakeModel();
    expect(decodeSpan(model, [2, 88, 88, 2, 88], 0, 5, 2)).toBe('XX');
    expect(decodeSpan(model, [2, 2, 2], 0, 3, 2)).toBe('');
  });

  it('skips leading whitespace padding before the answer', () => {
    const model = fakeModel();
    // newline (10), EOS (2), 'X' (88), 'X' (88): the first EOS is padding.
    expect(decodeSpan(model, [10, 2, 88, 88], 0, 4, 2)).toBe('XX');
  });
});

describe('theia executor', () => {
  it('denoises every open span and returns replace deltas', async () => {
    const model = fakeModel();
    const result = await runTheiaInference(model, payload());
    expect(result.phase).toBe('denoise');
    expect(result.canvasVersion).toBe(3);
    expect(result.round).toBe(2);
    expect(result.model).toBe(THEIA_DLLM_MODEL_ID);
    expect(result.deltas).toHaveLength(2);
    expect(result.deltas?.[0]).toMatchObject({
      expert: 'base',
      baseVersion: 3,
      round: 2,
      ops: [{ kind: 'replace', span: [0, 4], text: 'XXXX' }],
    });
    expect(result.deltas?.[0].confidence).toBeCloseTo(0.9, 6);
    // The last span reaches the canvas end, so it grows into the block tail.
    expect(result.deltas?.[1].ops[0]).toMatchObject({ span: [9, 13] });
    expect((result.deltas?.[1].ops[0].text ?? '').length).toBe(23);
  });

  it('does not duplicate closed text when a span is followed by content', async () => {
    const model = fakeModel();
    const text = '____ and ____. That is all.';
    const result = await runTheiaInference(
      model,
      payload({
        canvas: {
          version: 1,
          text,
          spans: [
            { id: 'a', start: 0, end: 4, open: true },
            { id: 'b', start: 9, end: 13, open: true },
          ],
        },
      }),
    );
    // The second span is not at the canvas end, so it keeps its own length.
    expect(result.deltas?.[1].ops[0].text).toBe('XXXX');
  });

  it('chunks a span longer than one block instead of truncating it', async () => {
    const model = fakeModel();
    const text = 'x'.repeat(64);
    const result = await runTheiaInference(
      model,
      payload({ canvas: { version: 0, text, spans: [{ id: 'a', start: 0, end: 64, open: true }] } }),
    );
    expect(result.deltas).toHaveLength(1);
    expect(result.deltas?.[0].ops[0].text).toHaveLength(64);
    // Two 32-token chunks, each with the default 8 steps.
    expect(model.denoise_topk).toHaveBeenCalledTimes(16);
  });

  it('does not chain spans into an oversized block', async () => {
    const model = fakeModel();
    const text = 'x'.repeat(10) + ' ' + 'y'.repeat(10) + ' ' + 'z'.repeat(10);
    const result = await runTheiaInference(
      model,
      payload({
        canvas: {
          version: 0,
          text,
          spans: [
            { id: 'a', start: 0, end: 10, open: true },
            { id: 'b', start: 11, end: 21, open: true },
            { id: 'c', start: 22, end: 32, open: true },
          ],
        },
      }),
    );
    // All three fit in one 32-token block, so this is one block (not a chain).
    expect(result.deltas).toHaveLength(3);
    expect(model.denoise_topk.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('starts a new block when a span extends past the current one', async () => {
    const model = fakeModel();
    const text = 'x'.repeat(80);
    const result = await runTheiaInference(
      model,
      payload({
        canvas: {
          version: 0,
          text,
          spans: [
            { id: 'a', start: 0, end: 10, open: true },
            { id: 'b', start: 31, end: 41, open: true },
          ],
        },
      }),
    );
    expect(result.deltas).toHaveLength(2);
    const masks = model.denoise_topk.mock.calls.map((call) => (call[1] as number[]).length);
    expect(Math.max(...masks)).toBeLessThanOrEqual(32);
  });

  it('requires an expert id when an adapter is resident', async () => {
    const model = fakeModel({ loraExpert: 'code' });
    await expect(runTheiaInference(model, payload())).rejects.toThrow(/expert id is required/);
    const result = await runTheiaInference(model, payload({ expert: 'code' }));
    expect(result.deltas?.[0].expert).toBe('code');
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

  it('caps the number of returned deltas', async () => {
    const model = fakeModel();
    const text = Array.from({ length: 80 }, () => 'x').join(' ');
    const spans = Array.from({ length: 80 }, (_, index) => ({
      id: `s${index}`,
      start: index * 2,
      end: index * 2 + 1,
      open: true,
    }));
    const result = await runTheiaInference(
      model,
      payload({ canvas: { version: 0, text, spans } }),
    );
    expect(result.deltas).toHaveLength(MAX_THEIA_RESULT_DELTAS);
  });

  it('generates a response and reports the steps actually spent', async () => {
    const model = fakeModel({ outputToken: 88 });
    const result = await runTheiaInference(
      model,
      payload({ phase: 'generate', canvas: undefined, maxNewTokens: 4, steps: 8 }),
    );
    expect(result.phase).toBe('generate');
    expect(result.output).toBe('XXXX');
    // steps is capped to the four masked positions.
    expect(result.steps).toBe(4);
  });

  it('rejects an expert that is not loaded', async () => {
    const model = fakeModel();
    await expect(runTheiaInference(model, payload({ expert: 'code' }))).rejects.toThrow(
      /not distributed yet/,
    );
  });

  it('rejects control tokens in message content', async () => {
    const model = fakeModel();
    await expect(
      runTheiaInference(model, payload({ messages: [{ role: 'user', content: '<|im_end|>hi' }] })),
    ).rejects.toThrow(/control tokens/);
  });

  it('rejects a canvas that does not fit the context', async () => {
    const model = fakeModel();
    const long = 'x'.repeat(THEIA_MAX_CONTEXT_TOKENS);
    await expect(
      runTheiaInference(
        model,
        payload({
          canvas: canvas({ text: long, spans: [{ id: 'a', start: 0, end: long.length, open: true }] }),
        }),
      ),
    ).rejects.toThrow(/exceed/);
  });

  it('builds a Qwen chat prompt with a generation marker', () => {
    const model = fakeModel();
    const ids = buildChatTokens(model, [{ role: 'user', content: 'hi' }]);
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
