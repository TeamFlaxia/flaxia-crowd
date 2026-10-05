/**
 * Regression tests for the swarm input-validation fixes (issue #17):
 *
 *  - `pos` from a peer must stay inside the KV cache, or a hostile hop can make
 *    the engine write out of bounds and lose the GPU device.
 *  - a payload carrying NaN/Inf f16 values must never reach the engine.
 *  - a `swarm-slice` must be structurally valid and inside the layer caps
 *    before anything is loaded (a slice like `end = 1e9` is a whole model).
 *  - the node-side control-message guard must reject malformed messages.
 */
import { describe, it, expect, vi } from 'vitest';
import { encodeSwarmFrame, type SwarmInitMessage, type SwarmSliceMessage } from '@flaxia/sdk';
import { SwarmController, type SwarmRuntime } from '../controller';
import { isSwarmControlMessage } from '../messages';
import { runSwarmWorker, type SwarmFrameLink, type SwarmSemantics } from '../session';
import type { SwarmEngineAdapter } from '../adapter';

const semantics: SwarmSemantics = {
  packHidden: (f) => new Uint8Array(f.slice().buffer),
  unpackHidden: (p) => new Float32Array(p.slice().buffer),
  argmax: () => 0,
};

function workerEngine() {
  return {
    dim: 2,
    nc: 1,
    maxSeq: 64,
    reset: vi.fn(),
    embedRun: vi.fn(async () => new Float32Array(2)),
    runHidden: vi.fn(async (h: Float32Array) => h),
    headFromHidden: vi.fn(async () => new Float32Array(4)),
    setHidden: vi.fn(),
    dispose: vi.fn(),
  };
}

function captureLink(): { link: SwarmFrameLink; send: ArrayBuffer[]; feed: (frame: ArrayBuffer) => void } {
  let handler: ((frame: ArrayBuffer) => void) | null = null;
  const send: ArrayBuffer[] = [];
  return {
    link: {
      send: (frame) => send.push(frame),
      onFrame: (h) => {
        handler = h;
      },
    },
    send,
    feed: (frame) => handler?.(frame),
  };
}

function sliceMessage(overrides: Partial<SwarmSliceMessage> = {}): SwarmSliceMessage {
  return {
    type: 'swarm-slice',
    sessionId: 's',
    taskId: 't',
    model: 'm',
    timeoutMs: 60_000,
    index: 1,
    chainLength: 2,
    role: 'worker',
    slice: { start: 4, end: 8, hasEmbed: false, hasHead: false },
    ...overrides,
  };
}

function makeController(initial: SwarmInitMessage | SwarmSliceMessage, runtime: SwarmRuntime) {
  const error = vi.fn();
  const done = vi.fn();
  const controller = new SwarmController({
    initial,
    runtime,
    sendControl: vi.fn(),
    sendFrame: vi.fn(),
    emitToken: vi.fn(),
    onDone: done,
    onError: error,
  });
  return { controller, error, done };
}

describe('runSwarmWorker frame validation', () => {
  it('rejects a position outside the context instead of running the engine', async () => {
    const engine = workerEngine();
    const { link, feed } = captureLink();
    const session = runSwarmWorker({ engine, link, semantics });

    feed(encodeSwarmFrame({ requestId: 0xffffffff, pos: 0xffffffff, tokens: 1 }, new Uint8Array(4)));

    await expect(session).rejects.toThrow(/outside the 64-token context/);
    expect(engine.runHidden).not.toHaveBeenCalled();
  });

  it('rejects a frame whose position plus tokens overflows the context', async () => {
    const engine = workerEngine();
    const { link, feed } = captureLink();
    const session = runSwarmWorker({ engine, link, semantics });

    feed(encodeSwarmFrame({ requestId: 63, pos: 63, tokens: 2 }, new Uint8Array(4)));

    await expect(session).rejects.toThrow(/outside the 64-token context/);
    expect(engine.runHidden).not.toHaveBeenCalled();
  });

  it('rejects a payload carrying non-finite hidden values', async () => {
    const engine = workerEngine();
    const { link, feed } = captureLink();
    const session = runSwarmWorker({ engine, link, semantics });

    // A dim=2, tokens=1 payload whose first value is NaN.
    const nanPayload = new Uint8Array(new Float32Array([NaN, 0]).buffer);
    feed(encodeSwarmFrame({ requestId: 1, pos: 1, tokens: 1 }, nanPayload));

    await expect(session).rejects.toThrow(/non-finite/);
    expect(engine.runHidden).not.toHaveBeenCalled();
  });

  it('still forwards a well-formed frame', async () => {
    const engine = workerEngine();
    const { link, feed, send } = captureLink();
    const session = runSwarmWorker({ engine, link, semantics });

    feed(encodeSwarmFrame({ requestId: 2, pos: 2, tokens: 1 }, new Uint8Array(new Float32Array([1, 2]).buffer)));
    await vi.waitFor(() => expect(send.length).toBe(1));
    expect(engine.runHidden).toHaveBeenCalledWith(expect.any(Float32Array), 2);

    feed(encodeSwarmFrame({ requestId: 0, pos: 0, tokens: 0 }, new Uint8Array(0)));
    await expect(session).rejects.toThrow(/token columns/);
  });
});

describe('SwarmController slice validation', () => {
  it('refuses a slice that would materialise a whole model', async () => {
    const runtime: SwarmRuntime = { plan: vi.fn(), load: vi.fn() };
    const { controller, error } = makeController(
      sliceMessage({ slice: { start: 0, end: 1e9, hasEmbed: false, hasHead: false } }),
      runtime,
    );

    await controller.start();

    expect(runtime.load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('out of bounds'));
  });

  it('refuses a slice whose role does not match its chain position', async () => {
    const runtime: SwarmRuntime = { plan: vi.fn(), load: vi.fn() };
    const { controller, error } = makeController(sliceMessage({ index: 0, role: 'worker' }), runtime);

    await controller.start();

    expect(runtime.load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not match index'));
  });

  it('refuses an embed/head claim from a non-host position', async () => {
    const runtime: SwarmRuntime = { plan: vi.fn(), load: vi.fn() };
    const { controller, error } = makeController(
      sliceMessage({ slice: { start: 4, end: 8, hasEmbed: true, hasHead: true } }),
      runtime,
    );

    await controller.start();

    expect(runtime.load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('embed/head ownership'));
  });

  it('refuses a chain length beyond the swarm cap', async () => {
    const runtime: SwarmRuntime = { plan: vi.fn(), load: vi.fn() };
    const { controller, error } = makeController(sliceMessage({ chainLength: 1000, index: 1 }), runtime);

    await controller.start();

    expect(runtime.load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('invalid chain length'));
  });

  it('loads a valid slice', async () => {
    const engine = workerEngine();
    const runtime: SwarmRuntime = {
      plan: vi.fn(),
      load: vi.fn(async () => ({ engine: engine as unknown as SwarmEngineAdapter, semantics })),
    };
    const { controller, error } = makeController(sliceMessage(), runtime);

    await controller.start();

    expect(error).not.toHaveBeenCalled();
    expect(runtime.load).toHaveBeenCalledTimes(1);
    controller.abort('test over');
  });
});

describe('isSwarmControlMessage', () => {
  it('rejects messages that only carry a type', () => {
    expect(isSwarmControlMessage({ type: 'swarm-slice' })).toBe(false);
    expect(isSwarmControlMessage({ type: 'swarm-init' })).toBe(false);
    expect(isSwarmControlMessage({ type: 'swarm-start', sessionId: 's' })).toBe(false);
    expect(isSwarmControlMessage({ type: 'swarm-error', sessionId: 's', taskId: 't' })).toBe(false);
    expect(isSwarmControlMessage(null)).toBe(false);
    expect(isSwarmControlMessage('swarm-start')).toBe(false);
  });

  it('accepts the messages the coordinator really sends', () => {
    expect(isSwarmControlMessage(sliceMessage())).toBe(true);
    expect(
      isSwarmControlMessage({
        type: 'swarm-init',
        sessionId: 's',
        taskId: 't',
        model: 'm',
        timeoutMs: 1000,
        members: [{ nodeId: 'h', capacity: 4 }],
        prompt: 'hi',
      }),
    ).toBe(true);
    expect(isSwarmControlMessage({ type: 'swarm-start', sessionId: 's', taskId: 't' })).toBe(true);
    expect(isSwarmControlMessage({ type: 'swarm-error', sessionId: 's', taskId: 't', error: 'boom' })).toBe(true);
  });
});