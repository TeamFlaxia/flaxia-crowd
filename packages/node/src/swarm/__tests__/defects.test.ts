/**
 * Regression tests for the swarm node runtime, written from the
 * feature/swarm-inference quality review and kept after the fixes landed.
 *
 * Every test here encodes the behaviour we WANT. Do not weaken a test in this
 * file to make the suite green — if one of these starts failing, the defect it
 * documents has come back.
 *
 *   H2  the engine / GPU device must be disposed when a session ends
 *   M1  `maxNewTokens` and the prompt are validated against the model
 *   M2  a coordinator `swarm-error` settles the local session
 *   M4  the host result conforms to `SwarmInferenceResult`
 *   M6  malformed or stray hidden-state frames are never trusted
 */

import { describe, it, expect, vi } from 'vitest';
import {
  encodeSwarmFrame,
  encodeSwarmStopFrame,
  type SwarmChainNode,
  type SwarmInitMessage,
  type SwarmSliceMessage,
  type SwarmStartMessage,
} from '@flaxia/sdk';
import { SwarmController, type SwarmRuntime } from '../controller';
import type { SwarmEngineAdapter } from '../adapter';
import type { SwarmSemantics } from '../session';

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

// No `: SwarmEngineAdapter` annotation on purpose: the tests inspect the
// `vi.fn()` handles (`headFromHidden.mock`), which the interface erases.
function hostEngine() {
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

function makeRuntime(
  engine: SwarmEngineAdapter,
  chain: SwarmChainNode[] = [],
  modelSemantics: SwarmSemantics = semantics,
): SwarmRuntime {
  return {
    plan: vi.fn(async () => chain),
    load: vi.fn(async () => ({ engine, semantics: modelSemantics })),
  };
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

const CHAIN1: SwarmChainNode[] = [
  { nodeId: 'h', role: 'host', slice: { start: 0, end: 8, hasEmbed: true, hasHead: true } },
];
const CHAIN2: SwarmChainNode[] = [
  { nodeId: 'h', role: 'host', slice: { start: 0, end: 6, hasEmbed: true, hasHead: true } },
  { nodeId: 'w', role: 'worker', slice: { start: 6, end: 8, hasEmbed: false, hasHead: false } },
];

function hostInit(members: SwarmInitMessage['members'], extra: Partial<SwarmInitMessage> = {}): SwarmInitMessage {
  return {
    type: 'swarm-init',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60000,
    members,
    prompt: 'hi',
    maxNewTokens: 3,
    ...extra,
  };
}

const SOLO_MEMBERS: SwarmInitMessage['members'] = [{ nodeId: 'h', capacity: 4 }];
const CHAIN_MEMBERS: SwarmInitMessage['members'] = [
  { nodeId: 'h', capacity: 4 },
  { nodeId: 'w', capacity: 4 },
];

function hostSlice(chainLength: number): SwarmSliceMessage {
  return {
    type: 'swarm-slice',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60000,
    index: 0,
    chainLength,
    role: 'host',
    slice: { start: 0, end: chainLength === 1 ? 8 : 6, hasEmbed: true, hasHead: true },
  };
}

const swarmStart = (): SwarmStartMessage => ({
  type: 'swarm-start',
  sessionId: 's',
  taskId: 't',
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met within ' + ms + 'ms');
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

describe('H2: the engine must be disposed when a session ends', () => {
  it('disposes the host engine after generation finishes', async () => {
    const engine = hostEngine();
    const { controller, done } = await armHost(hostInit(SOLO_MEMBERS), makeRuntime(engine, CHAIN1));

    await controller.handleControl(swarmStart());

    expect(done).toHaveBeenCalledTimes(1);
    // Nothing in the controller releases the engine, so every swarm task leaks
    // a GPU device (and its weights) in a worker that is reused for the next one.
    expect(engine.dispose).toHaveBeenCalled();
  });

  it('disposes the worker engine after the stop frame', async () => {
    const engine = workerEngine();
    const slice: SwarmSliceMessage = {
      type: 'swarm-slice',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 60000,
      index: 1,
      chainLength: 2,
      role: 'worker',
      slice: { start: 6, end: 8, hasEmbed: false, hasHead: false },
    };
    const { controller, done } = makeOptions(slice, makeRuntime(engine));

    await controller.start();
    controller.handleFrame(encodeSwarmStopFrame());
    await sleep(10);

    expect(done).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalled();
  });
});

describe('M1: generation parameters must be validated', () => {
  it('does not silently generate nothing when maxNewTokens is not a number', async () => {
    const engine = hostEngine();
    const init = hostInit(SOLO_MEMBERS, { maxNewTokens: 'abc' as unknown as number });
    const { controller, done, error } = await armHost(init, makeRuntime(engine, CHAIN1));

    await controller.handleControl(swarmStart());

    const produced = (done.mock.calls[0]?.[0] as { tokens?: unknown[] } | undefined)?.tokens ?? [];
    // Either reject the payload through onError, or fall back to the default
    // and actually generate. Today `0 < NaN` is false, so the loop never runs
    // and the caller gets an empty completion it cannot distinguish from
    // "the model had nothing to say".
    expect(error.mock.calls.length > 0 || produced.length > 0).toBe(true);
  });

  it('refuses a prompt that does not fit the model context', async () => {
    const engine = hostEngine();
    const longContext: SwarmSemantics = { ...semantics, encodePrompt: () => new Array(5000).fill(5) };
    const init = hostInit(SOLO_MEMBERS);
    const { controller, done, error } = await armHost(init, makeRuntime(engine, CHAIN1, longContext));

    await controller.handleControl(swarmStart());

    // SESSION_MAX_SEQ is 4096 and nothing checks the prompt against it, so the
    // engine is handed positions its KV cache cannot hold.
    expect(error).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });
});

describe('M4: the host result must conform to SwarmInferenceResult', () => {
  it('reports the nodes that took part in the session', async () => {
    const engine = hostEngine();
    const { controller, done } = await armHost(hostInit(SOLO_MEMBERS), makeRuntime(engine, CHAIN1));

    await controller.handleControl(swarmStart());

    const result = done.mock.calls[0][0] as {
      output: string;
      nodes: Array<Record<string, unknown>>;
      durationMs: number;
    };
    expect(typeof result.output).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    // `SwarmInferenceNodeInfo[]` is part of the declared result but the host
    // hard-codes `nodes: []`.
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes[0]).toMatchObject({ host: true });
    expect(Array.isArray(result.nodes[0].layers)).toBe(true);
  });
});

describe('M6: hidden-state frames must be validated', () => {
  it('does not throw out of handleFrame when the payload is malformed', async () => {
    const engine = hostEngine();
    const { controller, frames } = await armHost(hostInit(CHAIN_MEMBERS), makeRuntime(engine, CHAIN2));

    const started = controller.handleControl(swarmStart()).catch(() => {});
    await until(() => frames.length >= 1);

    // 3 bytes: decodes as a valid header, then `unpackHidden` builds a typed
    // array over a buffer whose length is not a multiple of 2 and throws —
    // straight out of the worker's message handler.
    const bad = encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(3));
    expect(() => controller.handleFrame(bad)).not.toThrow();

    void started;
  });

  it('ignores a frame whose position does not match the pending hop', async () => {
    const engine = hostEngine();
    const { controller, frames } = await armHost(hostInit(CHAIN_MEMBERS), makeRuntime(engine, CHAIN2));

    const started = controller.handleControl(swarmStart()).catch(() => {});
    await until(() => frames.length >= 1);

    const headCalls = engine.headFromHidden.mock.calls.length;
    // `requestId` / `pos` are written into the header but never checked on the
    // receiving side, so any frame resolves the host's pending round trip.
    controller.handleFrame(
      encodeSwarmFrame({ requestId: 99, pos: 99, tokens: 1 }, new Uint8Array(8)),
    );
    await sleep(20);
    expect(engine.headFromHidden.mock.calls.length).toBe(headCalls);

    controller.handleFrame(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(8)));
    await sleep(20);
    expect(engine.headFromHidden.mock.calls.length).toBeGreaterThan(headCalls);

    void started;
  });

  it('ignores a frame whose hidden size does not match engine.dim', async () => {
    const engine = hostEngine();
    const { controller, frames } = await armHost(hostInit(CHAIN_MEMBERS), makeRuntime(engine, CHAIN2));

    const started = controller.handleControl(swarmStart()).catch(() => {});
    await until(() => frames.length >= 1);

    const headCalls = engine.headFromHidden.mock.calls.length;
    // dim is 2 (8 bytes of f16); a 16 byte payload yields 4 values and silently
    // corrupts the state instead of being rejected.
    controller.handleFrame(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(16)));
    await sleep(20);
    expect(engine.headFromHidden.mock.calls.length).toBe(headCalls);

    void started;
  });

  it('surfaces a malformed frame on the worker instead of hanging', async () => {
    const engine = workerEngine();
    const slice: SwarmSliceMessage = {
      type: 'swarm-slice',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 60000,
      index: 1,
      chainLength: 2,
      role: 'worker',
      slice: { start: 6, end: 8, hasEmbed: false, hasHead: false },
    };
    const { controller, done, error } = makeOptions(slice, makeRuntime(engine));

    await controller.start();
    controller.handleFrame(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 1 }, new Uint8Array(3)));
    await sleep(20);

    // The rejection inside the serialized frame chain is never caught, so the
    // worker neither finishes nor reports an error: the session hangs until the
    // coordinator's 30 minute timeout.
    expect(error.mock.calls.length + done.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('M2 (node side): a coordinator swarm-error settles the session', () => {
  it('fails the local session instead of waiting for the task timeout', async () => {
    const engine = workerEngine();
    const slice: SwarmSliceMessage = {
      type: 'swarm-slice',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 60000,
      index: 1,
      chainLength: 2,
      role: 'worker',
      slice: { start: 6, end: 8, hasEmbed: false, hasHead: false },
    };
    const { controller, done, error } = makeOptions(slice, makeRuntime(engine));

    await controller.start();
    await controller.handleControl({
      type: 'swarm-error',
      sessionId: 's',
      taskId: 't',
      error: 'swarm plan is not a valid contiguous layer chain',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('swarm plan is not a valid'));
    expect(done).not.toHaveBeenCalled();
    // The engine must not be left resident on a worker that is reused.
    expect(engine.dispose).toHaveBeenCalled();
  });
});
