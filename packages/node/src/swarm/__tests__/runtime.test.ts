import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSemantics, rangeFetch, resolveModelUrl } from '../runtime';
import type { PooledEngineModule, PooledTokenizer } from '../adapter';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveModelUrl', () => {
  it('maps a known model id to its GGUF url', () => {
    expect(resolveModelUrl('qwen3.5-2b')).toContain('Qwen3.5-2B');
    expect(resolveModelUrl('qwen3.8-27b')).toContain('Qwen3.8-27B');
    expect(resolveModelUrl('qwen3.6-35b-moe')).toContain('Qwen3.6-35B');
  });

  // H3 (quality review): `model` is task payload, i.e. unvalidated user input.
  // Passing it straight through lets any API caller make every opted-in node
  // range-fetch an arbitrary host. Only the registry may be resolved.
  it('rejects an arbitrary https url', () => {
    expect(() => resolveModelUrl('https://evil.example/model.gguf')).toThrow(/swarm model|not allowed|registry/i);
  });

  it('rejects an unknown model id', () => {
    expect(() => resolveModelUrl('not-a-model')).toThrow(/unknown swarm model/);
  });
});

describe('rangeFetch', () => {
  it('returns the requested bytes on a 206 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([7, 8, 9]).buffer, { status: 206 })),
    );
    expect(Array.from(await rangeFetch('https://x/model', 0, 2))).toEqual([7, 8, 9]);
  });

  it('rejects when the host does not support range requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]).buffer, { status: 200 })));
    await expect(rangeFetch('https://x/model', 0, 0)).rejects.toThrow(/refused range requests/);
  });

  it('rejects a short body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2]).buffer, { status: 206 })));
    await expect(rangeFetch('https://x/model', 0, 4)).rejects.toThrow(/short range/);
  });
});

describe('buildSemantics', () => {
  const tokenizer: PooledTokenizer = {
    vocab: {
      '<|im_start|>': 0,
      '<|im_end|>': 1,
      '<think>': 2,
      '</think>': 3,
      '<|endoftext|>': 4,
    },
    encode: () => [10, 11],
    decode: (ids) => ids.join('|'),
  };

  const mod = {
    f32ToF16: (v: number) => (v * 4) | 0,
    f16ToF32: (h: number) => h / 4,
    argmax: (logits: Float32Array) => {
      let best = 0;
      for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
      return best;
    },
  } as unknown as PooledEngineModule;

  it('round-trips hidden states through the f16 payload', () => {
    const semantics = buildSemantics(mod, tokenizer);
    const packed = semantics.packHidden(Float32Array.from([1, 2, 3]));
    expect(packed.byteLength).toBe(6);
    expect(Array.from(semantics.unpackHidden(packed))).toEqual([1, 2, 3]);
  });

  it('wraps the prompt in the chat template and marks the end tokens', () => {
    const semantics = buildSemantics(mod, tokenizer);
    const ids = semantics.encodePrompt!('hi');
    expect(ids[0]).toBe(0); // <|im_start|>
    expect(ids).toContain(1); // <|im_end|>
    expect(ids).toContain(10);
    // the thinking block must open before it closes (the tokens are "<think>" / "</think>")
    const open = ids.indexOf(2);
    const close = ids.indexOf(3);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(Array.from(semantics.eosIds!)).toEqual([1, 4]);
    expect(semantics.decodeTokens!([5, 6])).toBe('5|6');
    expect(semantics.argmax(Float32Array.from([0, 3, 1]))).toBe(1);
  });

  it('joins an array prompt', () => {
    const semantics = buildSemantics(mod, tokenizer);
    expect(semantics.encodePrompt!(['a', 'b']).length).toBeGreaterThan(0);
  });
});
