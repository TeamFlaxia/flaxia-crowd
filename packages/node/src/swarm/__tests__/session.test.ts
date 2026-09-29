import { describe, it, expect, vi } from 'vitest';
import type { SwarmEngineAdapter } from '../adapter';
import {
  runSwarmHost,
  runSwarmWorker,
  type SwarmFrameLink,
  type SwarmSemantics,
} from '../session';

const VOCAB = 100;

const semantics: SwarmSemantics = {
  packHidden: (f) => new Uint8Array(f.slice().buffer),
  unpackHidden: (p) => new Float32Array(p.slice().buffer),
  argmax: (logits) => {
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return best;
  },
};

function baseAdapter(overrides: Partial<SwarmEngineAdapter>): SwarmEngineAdapter {
  return {
    dim: 2,
    nc: 1,
    reset: vi.fn(),
    embedRun: vi.fn(async () => new Float32Array(2)),
    runHidden: vi.fn(async () => new Float32Array(2)),
    headFromHidden: vi.fn(async () => new Float32Array(VOCAB)),
    setHidden: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

// embed(token) = [token, 0]; head maps hidden[0]=t to logits with argmax = t+1.
function hostEngine() {
  return baseAdapter({
    embedRun: vi.fn(async (token: number, _pos: number) => Float32Array.from([token, 0])),
    headFromHidden: vi.fn(async (h: Float32Array) => {
      const logits = new Float32Array(VOCAB);
      logits[(h[0] + 1) % VOCAB] = 1;
      return logits;
    }),
  });
}

// Passes token through, bumps the position channel so a test can see it ran.
function workerEngine() {
  return baseAdapter({
    runHidden: vi.fn(async (h: Float32Array, _pos: number) => Float32Array.from([h[0], h[1] + 1])),
  });
}

/** Wire two links so each one's send lands on the other's frame handler. */
function makePair() {
  let hostHandler: ((f: ArrayBuffer) => void) | null = null;
  let workerHandler: ((f: ArrayBuffer) => void) | null = null;
  const hostLink: SwarmFrameLink = {
    send: (f) => workerHandler?.(f),
    onFrame: (h) => { hostHandler = h; },
  };
  const workerLink: SwarmFrameLink = {
    send: (f) => hostHandler?.(f),
    onFrame: (h) => { workerHandler = h; },
  };
  return { hostLink, workerLink };
}

describe('runSwarmHost (single node)', () => {
  it('generates without sending any frames', async () => {
    const engine = hostEngine();
    const send = vi.fn();
    const { hostLink } = makePair();
    hostLink.send = send;

    const result = await runSwarmHost({
      chainLength: 1,
      promptTokens: [5],
      maxNewTokens: 4,
      engine,
      link: hostLink,
      semantics,
    });

    expect(result.tokens).toEqual([6, 7, 8, 9]);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops before emitting the EOS id', async () => {
    const engine = hostEngine();
    const { hostLink } = makePair();
    hostLink.send = vi.fn();

    const result = await runSwarmHost({
      chainLength: 1,
      promptTokens: [5],
      maxNewTokens: 10,
      engine,
      link: hostLink,
      semantics,
      eosIds: new Set([7]),
    });

    expect(result.tokens).toEqual([6]);
  });

  it('rejects an empty prompt', async () => {
    const { hostLink } = makePair();
    await expect(
      runSwarmHost({
        chainLength: 1,
        promptTokens: [],
        maxNewTokens: 1,
        engine: hostEngine(),
        link: hostLink,
        semantics,
      }),
    ).rejects.toThrow(/prompt token/);
  });
});

describe('runSwarmHost + runSwarmWorker (two-node chain)', () => {
  it('routes every step through the worker and produces the same tokens', async () => {
    const { hostLink, workerLink } = makePair();
    const host = hostEngine();
    const worker = workerEngine();

    const workerDone = runSwarmWorker({ engine: worker, link: workerLink, semantics });
    const result = await runSwarmHost({
      chainLength: 2,
      promptTokens: [5],
      maxNewTokens: 4,
      engine: host,
      link: hostLink,
      semantics,
    });
    await workerDone;

    expect(result.tokens).toEqual([6, 7, 8, 9]);
    // 1 prompt embed + 3 decode steps each cross the worker.
    expect(worker.runHidden).toHaveBeenCalledTimes(4);
  });

  it('streams each generated token to onToken', async () => {
    const { hostLink, workerLink } = makePair();
    const seen: number[] = [];
    const workerDone = runSwarmWorker({ engine: workerEngine(), link: workerLink, semantics });
    await runSwarmHost({
      chainLength: 2,
      promptTokens: [5],
      maxNewTokens: 3,
      engine: hostEngine(),
      link: hostLink,
      semantics,
      onToken: (id) => seen.push(id),
    });
    await workerDone;
    expect(seen).toEqual([6, 7, 8]);
  });

  it('lets a three-node chain run both workers in order', async () => {
    let h1: ((f: ArrayBuffer) => void) | null = null;
    let h2: ((f: ArrayBuffer) => void) | null = null;
    let h3: ((f: ArrayBuffer) => void) | null = null;

    const hostLink: SwarmFrameLink = { send: (f) => h1?.(f), onFrame: (h) => { h3 = h; } };
    const w1Link: SwarmFrameLink = { send: (f) => h2?.(f), onFrame: (h) => { h1 = h; } };
    const w2Link: SwarmFrameLink = { send: (f) => h3?.(f), onFrame: (h) => { h2 = h; } };

    const w1 = workerEngine();
    const w2 = workerEngine();
    const d1 = runSwarmWorker({ engine: w1, link: w1Link, semantics });
    const d2 = runSwarmWorker({ engine: w2, link: w2Link, semantics });

    const result = await runSwarmHost({
      chainLength: 3,
      promptTokens: [5],
      maxNewTokens: 3,
      engine: hostEngine(),
      link: hostLink,
      semantics,
    });
    await Promise.all([d1, d2]);

    expect(result.tokens).toEqual([6, 7, 8]);
    expect(w1.runHidden).toHaveBeenCalledTimes(3);
    expect(w2.runHidden).toHaveBeenCalledTimes(3);
  });
});
