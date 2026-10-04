/**
 * Regression tests for the swarm node hardening pass. Each one documents a
 * concrete way a coordinator (or a peer it relays for) could have made a node
 * allocate, hang, or build an engine slice outside the plan:
 *
 *   S1  a hidden-state frame is size-checked before it is decoded
 *   S2  a session that stops making progress ends on its deadline instead of
 *       awaiting forever, disposing the engine and releasing the worker slot
 *   S3  a coordinator-supplied slice is validated against the model before it
 *       reaches the engine
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeSwarmFrame,
  SWARM_FRAME_HEADER_BYTES,
  type SwarmChainNode,
  type SwarmInitMessage,
  type SwarmSliceMessage,
} from '@flaxia/sdk';
import { SwarmController, type SwarmRuntime } from '../controller';
import { findSwarmSliceProblem, isSwarmSlice } from '../messages';
import { isOversizedFrame, MAX_FRAME_BYTES, runSwarmHost, runSwarmWorker, type SwarmFrameLink, type SwarmSemantics } from '../session';
import type { SwarmEngineAdapter } from '../adapter';

const VOCAB = 50;

const semantics: SwarmSemantics = {
  packHidden: (f) => new Uint8Array(f.slice().buffer),
  unpackHidden: (p) => new Float32Array(p.slice().buffer),
  argmax: (logits) => {
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return best;
  },
  encodePrompt: () => [5],
  decodeTokens: (ids) => ids.join(','),
};

function hostEngine(): SwarmEngineAdapter {
  return {
    dim: 2,
    nc: 1,
    reset: vi.fn(),
    embedRun: vi.fn(async (token: number) => Float32Array.from([token, 0])),
    runHidden: vi.fn(async (h: Float32Array) => h),
    headFromHidden: vi.fn(async (h: Float32Array) => {
      const logits = new Float32Array(VOCAB);
      logits[(h[0] + 1) % VOCAB] = 1;
      return logits;
    }),
    setHidden: vi.fn(),
    dispose: vi.fn(),
  };
}

function workerEngine(): SwarmEngineAdapter {
  return {
    dim: 2,
    nc: 1,
    reset: vi.fn(),
    embedRun: vi.fn(async () => new Float32Array(2)),
    runHidden: vi.fn(async (h: Float32Array) => Float32Array.from([h[0], h[1] + 1])),
    headFromHidden: vi.fn(async () => new Float32Array(VOCAB)),
    setHidden: vi.fn(),
    dispose: vi.fn(),
  };
}

/** Layers the fake model claims to have; slices are validated against it. */
const MODEL_LAYERS = 8;

function makeRuntime(engine: SwarmEngineAdapter, chain: SwarmChainNode[] = [], layers?: number): SwarmRuntime {
  const runtime: SwarmRuntime = {
    plan: vi.fn(async () => chain),
    load: vi.fn(async () => ({ engine, semantics })),
  };
  if (layers !== undefined) {
    runtime.resolveLayers = vi.fn(async () => layers);
  }
  return runtime;
}

function makeOptions(initial: SwarmInitMessage | SwarmSliceMessage, runtime: SwarmRuntime) {
  const controls: unknown[] = [];
  const frames: ArrayBuffer[] = [];
  const tokens: string[] = [];
  const done = vi.fn();
  const error = vi.fn();
  const controller = new SwarmController({
    initial,
    runtime,
    sendControl: (m) => controls.push(m),
    sendFrame: (f) => frames.push(f),
    emitToken: (t) => tokens.push(t),
    onDone: done,
    onError: error,
  });
  return { controller, controls, frames, tokens, done, error };
}

const CHAIN2: SwarmChainNode[] = [
  { nodeId: 'h', role: 'host', slice: { start: 0, end: 6, hasEmbed: true, hasHead: true } },
  { nodeId: 'w', role: 'worker', slice: { start: 6, end: 8, hasEmbed: false, hasHead: false } },
];

const CHAIN_MEMBERS: SwarmInitMessage['members'] = [
  { nodeId: 'h', capacity: 4 },
  { nodeId: 'w', capacity: 4 },
];

function hostInit(extra: Partial<SwarmInitMessage> = {}): SwarmInitMessage {
  return {
    type: 'swarm-init',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60000,
    members: CHAIN_MEMBERS,
    prompt: 'hi',
    maxNewTokens: 2,
    ...extra,
  };
}

function hostSlice(chainLength: number, slice = { start: 0, end: 6, hasEmbed: true, hasHead: true }): SwarmSliceMessage {
  return {
    type: 'swarm-slice',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60000,
    index: 0,
    chainLength,
    role: 'host',
    slice,
  };
}

function workerSlice(extra: Partial<SwarmSliceMessage> = {}): SwarmSliceMessage {
  return {
    type: 'swarm-slice',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60000,
    index: 1,
    chainLength: 2,
    role: 'worker',
    slice: { start: 6, end: 8, hasEmbed: false, hasHead: false },
    ...extra,
  };
}

const swarmStart = () => ({ type: 'swarm-start' as const, sessionId: 's', taskId: 't' });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await sleep(5);
  }
}

/** Bring a host controller up to (but not including) `swarm-start`. */
async function armHost(init: SwarmInitMessage, runtime: SwarmRuntime) {
  const h = makeOptions(init, runtime);
  await h.controller.start();
  await h.controller.handleControl(hostSlice(init.members.length));
  return h;
}

/** An oversized frame with a valid header, so only the size check can refuse it. */
function oversizedFrame(): ArrayBuffer {
  const frame = new ArrayBuffer(MAX_FRAME_BYTES + SWARM_FRAME_HEADER_BYTES);
  new Uint8Array(frame).set(new Uint8Array(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(8))));
  return frame;
}

describe('S1: frames are size-checked before decoding', () => {
  it('accepts a frame at the limit and rejects anything larger', () => {
    expect(isOversizedFrame(new ArrayBuffer(MAX_FRAME_BYTES))).toBe(false);
    expect(isOversizedFrame(new ArrayBuffer(MAX_FRAME_BYTES + 1))).toBe(true);
    expect(isOversizedFrame(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(8)))).toBe(false);
  });

  it('fails the host hop on an oversized frame without throwing out of handleFrame', async () => {
    const engine = hostEngine();
    const { controller, frames, error, done } = await armHost(hostInit(), makeRuntime(engine, CHAIN2));

    const started = controller.handleControl(swarmStart()).catch(() => {});
    await until(() => frames.length >= 1);

    // A frame big enough that decoding it would allocate 16 MiB+ for a hop that
    // carries at most a few hundred KiB.
    expect(() => controller.handleFrame(oversizedFrame())).not.toThrow();
    await started;

    expect(error).toHaveBeenCalledWith(expect.stringContaining('byte limit'));
    expect(engine.headFromHidden).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
  });

  it('fails an oversized frame on the worker instead of buffering it', async () => {
    const engine = workerEngine();
    const { controller, error, done } = makeOptions(workerSlice(), makeRuntime(engine));
    await controller.start();

    expect(() => controller.handleFrame(oversizedFrame())).not.toThrow();
    await until(() => error.mock.calls.length > 0);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('byte limit'));
    expect(engine.runHidden).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
  });
});

describe('S2: sessions end on the coordinator deadline', () => {
  it('rejects a host hop that is never answered', async () => {
    const engine = hostEngine();
    let handler: ((frame: ArrayBuffer) => void) | null = null;
    // A link whose frames go nowhere: the peer never answers.
    const link: SwarmFrameLink = { send: () => {}, onFrame: (h) => { handler = h; } };

    await expect(
      runSwarmHost({
        chainLength: 2,
        promptTokens: [5],
        maxNewTokens: 2,
        engine,
        link,
        semantics,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
    expect(handler).not.toBeNull();
  });

  it('rejects a worker that never sees the stop frame', async () => {
    const engine = workerEngine();
    const link: SwarmFrameLink = { send: vi.fn(), onFrame: () => {} };

    await expect(runSwarmWorker({ engine, link, semantics, timeoutMs: 30 })).rejects.toThrow(/timed out/);
  });

  it('settles a stalled session through the abort path and releases the engine', async () => {
    const engine = workerEngine();
    const { controller, error, done } = makeOptions(workerSlice({ timeoutMs: 30 }), makeRuntime(engine));

    await controller.start();
    await until(() => error.mock.calls.length > 0);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    expect(done).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalled();
  });
});

describe('S3: a coordinator slice is validated before it is loaded', () => {
  it('rejects a slice past the model layer count without loading it', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine, [], MODEL_LAYERS);
    const { controller, controls, error, done } = makeOptions(
      workerSlice({ slice: { start: 6, end: 12, hasEmbed: false, hasHead: false } }),
      runtime,
    );

    await controller.start();

    expect(error).toHaveBeenCalledWith(expect.stringContaining(`beyond the model's ${MODEL_LAYERS} trunk layers`));
    expect(runtime.load).not.toHaveBeenCalled();
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(controls).toHaveLength(0);
    expect(done).not.toHaveBeenCalled();
  });

  it('rejects a slice that forges the embedding/head ownership', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine, [], MODEL_LAYERS);
    const { controller, error } = makeOptions(
      workerSlice({ slice: { start: 6, end: 8, hasEmbed: true, hasHead: true } }),
      runtime,
    );

    await controller.start();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('must not own the embedding/head'));
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it('rejects a worker slice that starts at layer 0', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine, [], MODEL_LAYERS);
    // index 1 with start 0 would overlap the host's embed/head layers.
    const { controller, error } = makeOptions(
      workerSlice({ slice: { start: 0, end: 4, hasEmbed: false, hasHead: false } }),
      runtime,
    );

    await controller.start();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('must not own the embedding/head'));
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it('rejects a host slice that holds every layer while sharing the chain', async () => {
    const engine = hostEngine();
    const runtime = makeRuntime(engine, CHAIN2, MODEL_LAYERS);
    const { controller, error } = makeOptions(hostInit(), runtime);
    await controller.start();

    await controller.handleControl(
      hostSlice(2, { start: 0, end: MODEL_LAYERS, hasEmbed: true, hasHead: true }),
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot hold every layer'));
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it('rejects a slice whose role does not match its chain index', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine, [], MODEL_LAYERS);
    const { controller, error } = makeOptions(
      workerSlice({ index: 0, slice: { start: 6, end: 8, hasEmbed: false, hasHead: false } }),
      runtime,
    );

    await controller.start();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not match chain index 0'));
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it('still loads a slice the model can honour', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine, [], MODEL_LAYERS);
    const { controller, controls, error } = makeOptions(workerSlice(), runtime);

    await controller.start();

    expect(error).not.toHaveBeenCalled();
    expect(runtime.load).toHaveBeenCalledTimes(1);
    expect(controls[0]).toMatchObject({ type: 'swarm-ready', sessionId: 's' });
  });
});

describe('slice validation (pure)', () => {
  it('accepts the host and worker slices buildSwarmChain produces', () => {
    expect(
      findSwarmSliceProblem(
        { start: 0, end: 4, hasEmbed: true, hasHead: true },
        { role: 'host', index: 0, chainLength: 2, totalLayers: 8 },
      ),
    ).toBeNull();
    expect(
      findSwarmSliceProblem(
        { start: 4, end: 8, hasEmbed: false, hasHead: false },
        { role: 'worker', index: 1, chainLength: 2, totalLayers: 8 },
      ),
    ).toBeNull();
    // A solo host owns the whole model.
    expect(
      findSwarmSliceProblem(
        { start: 0, end: 8, hasEmbed: true, hasHead: true },
        { role: 'host', index: 0, chainLength: 1, totalLayers: 8 },
      ),
    ).toBeNull();
  });

  it('rejects malformed, empty and negative slices', () => {
    expect(isSwarmSlice(null)).toBe(false);
    expect(isSwarmSlice({ start: 0, end: 4, hasEmbed: true })).toBe(false);
    expect(findSwarmSliceProblem({ start: 0, end: 0, hasEmbed: true, hasHead: true })).toMatch(/empty/);
    expect(findSwarmSliceProblem({ start: -1, end: 4, hasEmbed: false, hasHead: false })).toMatch(/negative/);
    expect(findSwarmSliceProblem({ start: 0.5, end: 4, hasEmbed: true, hasHead: true })).toMatch(/integers/);
    expect(findSwarmSliceProblem({ start: 0, end: 4, hasEmbed: true, hasHead: false })).toMatch(/together/);
  });

  it('rejects a chain position or role that cannot exist', () => {
    const slice = { start: 2, end: 4, hasEmbed: false, hasHead: false };
    expect(findSwarmSliceProblem(slice, { role: 'worker', index: 2, chainLength: 2 })).toMatch(/outside/);
    expect(findSwarmSliceProblem(slice, { chainLength: 0 })).toMatch(/positive integer/);
    expect(findSwarmSliceProblem(slice, { role: 'host', index: 1 })).toMatch(/does not match/);
    expect(findSwarmSliceProblem(slice, { role: 'peer' as never, index: 1 })).toMatch(/unknown role/);
  });
});
