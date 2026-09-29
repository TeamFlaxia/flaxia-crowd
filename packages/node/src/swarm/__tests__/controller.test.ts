import { describe, it, expect, vi } from 'vitest';
import {
  encodeSwarmFrame,
  encodeSwarmStopFrame,
  decodeSwarmFrame,
  type SwarmChainNode,
  type SwarmInitMessage,
  type SwarmSliceMessage,
} from '@flaxia/sdk';
import { SwarmController, type SwarmRuntime } from '../controller';
import type { SwarmEngineAdapter } from '../adapter';
import type { SwarmSemantics } from '../session';
import { isSwarmControlEnvelope, isSwarmFrameMessage } from '../messages';

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

function makeRuntime(engine: SwarmEngineAdapter, chain?: SwarmChainNode[]): SwarmRuntime {
  return {
    plan: vi.fn(async () => chain ?? []),
    load: vi.fn(async () => ({ engine, semantics })),
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

describe('SwarmController host', () => {
  it('plans, loads its slice, reports ready, then generates on start', async () => {
    const chain: SwarmChainNode[] = [
      { nodeId: 'h', role: 'host', slice: { start: 0, end: 8, hasEmbed: true, hasHead: true } },
    ];
    const runtime = makeRuntime(hostEngine(), chain);
    const init: SwarmInitMessage = {
      type: 'swarm-init',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 60000,
      members: [{ nodeId: 'h', capacity: 4 }],
      prompt: 'hi',
      maxNewTokens: 3,
    };
    const { controller, controls, tokens, done } = makeOptions(init, runtime);

    await controller.start();
    expect(controls[0]).toMatchObject({ type: 'swarm-plan', sessionId: 's', chain });

    await controller.handleControl({
      type: 'swarm-slice',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 60000,
      index: 0,
      chainLength: 1,
      role: 'host',
      slice: { start: 0, end: 8, hasEmbed: true, hasHead: true },
    });
    expect(controls[1]).toMatchObject({ type: 'swarm-ready', sessionId: 's' });

    await controller.handleControl({ type: 'swarm-start', sessionId: 's', taskId: 't' });
    expect(tokens).toEqual(['6', '7', '8']);
    expect(done).toHaveBeenCalledTimes(1);
    // M4 (quality review): `SwarmInferenceResult.tokens` is `string[]`, not the
    // raw ids the sampler produced.
    expect(done.mock.calls[0][0]).toMatchObject({ output: '6,7,8', tokens: ['6', '7', '8'] });
  });

  it('reports a runtime failure through onError', async () => {
    const runtime: SwarmRuntime = {
      plan: vi.fn(async () => {
        throw new Error('no metadata');
      }),
      load: vi.fn(),
    };
    const init: SwarmInitMessage = {
      type: 'swarm-init', sessionId: 's', taskId: 't', model: 'm', timeoutMs: 1000,
      members: [{ nodeId: 'h', capacity: 1 }], prompt: 'x',
    };
    const { controller, error, done } = makeOptions(init, runtime);
    await controller.start();
    expect(error).toHaveBeenCalledWith('no metadata');
    expect(done).not.toHaveBeenCalled();
  });
});

describe('SwarmController worker', () => {
  it('loads its slice, runs frames, and finishes on the stop frame', async () => {
    const engine = workerEngine();
    const runtime = makeRuntime(engine);
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
    const { controller, controls, frames, done } = makeOptions(slice, runtime);

    await controller.start();
    expect(controls[0]).toMatchObject({ type: 'swarm-ready', sessionId: 's' });

    controller.handleFrame(encodeSwarmFrame({ requestId: 1, pos: 0, tokens: 1 }, new Uint8Array(8)));
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.runHidden).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(decodeSwarmFrame(frames[0])).not.toBeNull();

    controller.handleFrame(encodeSwarmStopFrame());
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('swarm message guards', () => {
  it('recognizes control envelopes and frame messages', () => {
    expect(
      isSwarmControlEnvelope({ id: 't', type: 'swarm-control', message: { type: 'swarm-start', sessionId: 's', taskId: 't' } }),
    ).toBe(true);
    expect(isSwarmControlEnvelope({ id: 't', type: 'swarm-control', message: { type: 'nope' } })).toBe(false);
    expect(isSwarmFrameMessage({ id: 't', type: 'swarm-frame', frame: new ArrayBuffer(4) })).toBe(true);
    expect(isSwarmFrameMessage({ id: 't', type: 'swarm-frame', frame: new Uint8Array(4) })).toBe(false);
  });
});
