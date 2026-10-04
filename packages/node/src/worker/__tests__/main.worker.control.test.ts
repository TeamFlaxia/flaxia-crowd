import { describe, it, expect, vi, beforeEach } from 'vitest';

const { probeMockFactory } = vi.hoisted(() => ({
  probeMockFactory: () => ({
    HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
    probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
    hasEnoughWasmMemoryForHeavy: () => true,
  }),
}));
vi.mock('../../executor/memoryProbe', () => probeMockFactory());

// The swarm runtime pulls in the vendored engine; the controller is stubbed so
// the test only exercises the worker's own message validation.
vi.mock('../../swarm/runtime', () => ({ createSwarmRuntime: () => ({}) }));

const { handleControl, handleFrame, abort, controllerCtor } = vi.hoisted(() => {
  // The real controller settles its task through the callbacks it was given, so
  // the stub keeps them and lets `abort()` settle the pending worker promise.
  const pending: { reject: ((error: string) => void) | null } = { reject: null };
  const abort = vi.fn((reason: string) => {
    pending.reject?.(reason);
  });
  const controllerCtor = vi.fn((options: { onError: (error: string) => void }) => {
    pending.reject = options.onError;
  });
  return {
    handleControl: vi.fn().mockResolvedValue(undefined),
    handleFrame: vi.fn(),
    abort,
    controllerCtor,
  };
});

vi.mock('../../swarm/controller', () => ({
  SwarmController: class {
    constructor(options: { onError: (error: string) => void }) {
      controllerCtor(options);
    }
    start = vi.fn().mockResolvedValue(undefined);
    handleControl = handleControl;
    handleFrame = handleFrame;
    abort = abort;
  },
}));

const INIT = {
  type: 'swarm-init',
  sessionId: 's-1',
  model: 'qwen3.5-2b',
  prompt: 'hello',
  members: [],
};

/**
 * The worker module registers `self.onmessage` exactly once, so each test gets
 * a fresh module registry (and a fresh `self`) via `vi.resetModules()`.
 */
async function loadWorker(): Promise<{ selfObj: any; posts: any[] }> {
  vi.resetModules();
  const posts: any[] = [];
  const selfObj: any = { postMessage: (m: any) => posts.push(m) };
  Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });
  await import('../main.worker');
  return { selfObj, posts };
}

/**
 * Start a swarm task and wait until the stubbed controller is active. The task
 * promise is returned inside an object on purpose: returning it directly would
 * make this async helper adopt its (never self-settling) state.
 */
async function startSwarm(selfObj: any): Promise<{ task: Promise<unknown> }> {
  const task: Promise<unknown> = selfObj.onmessage({
    data: { id: 't-swarm', workload: 'swarm-inference', payload: INIT },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { task };
}

/** Settle the pending swarm task so the worker does not keep a promise open. */
async function settleSwarm(task: Promise<unknown>): Promise<void> {
  abort('done');
  await task.catch(() => undefined);
}

describe('main.worker swarm-control validation (#17)', () => {
  beforeEach(() => {
    // clearAllMocks keeps the stub implementations (abort must still reject).
    vi.clearAllMocks();
  });

  it('drops malformed swarm-control messages instead of forwarding them', async () => {
    const { selfObj } = await loadWorker();

    // No active session yet: even a valid control message has nowhere to go.
    selfObj.onmessage({ data: { id: 't1', type: 'swarm-control', message: INIT } });
    expect(handleControl).not.toHaveBeenCalled();

    const { task } = await startSwarm(selfObj);
    expect(controllerCtor).toHaveBeenCalledTimes(1);

    const malformed = [
      { id: 't-swarm', type: 'swarm-control' }, // no message
      { id: 't-swarm', type: 'swarm-control', message: null },
      { id: 't-swarm', type: 'swarm-control', message: 'swarm-start' },
      { id: 't-swarm', type: 'swarm-control', message: { type: 'not-a-control-type' } },
      { id: 't-swarm', type: 'swarm-control', message: [] },
      { type: 'swarm-control', message: { type: 'swarm-start', sessionId: 's-1' } }, // no id
      { id: 42, type: 'swarm-control', message: { type: 'swarm-start', sessionId: 's-1' } },
      { id: 't-swarm', type: 'not-swarm-control', message: { type: 'swarm-start', sessionId: 's-1' } },
    ];
    for (const data of malformed) {
      selfObj.onmessage({ data });
    }
    expect(handleControl).not.toHaveBeenCalled();

    // A well-formed envelope is forwarded to the active controller.
    selfObj.onmessage({
      data: { id: 't-swarm', type: 'swarm-control', message: { type: 'swarm-start', sessionId: 's-1' } },
    });
    expect(handleControl).toHaveBeenCalledTimes(1);
    expect(handleControl).toHaveBeenCalledWith({ type: 'swarm-start', sessionId: 's-1' });

    await settleSwarm(task);
  });

  it('drops a malformed swarm frame instead of passing it to the controller', async () => {
    const { selfObj } = await loadWorker();
    const { task } = await startSwarm(selfObj);

    selfObj.onmessage({ data: { id: 't-swarm', type: 'swarm-frame', frame: 'not-a-buffer' } });
    expect(handleFrame).not.toHaveBeenCalled();

    const frame = new ArrayBuffer(4);
    selfObj.onmessage({ data: { id: 't-swarm', type: 'swarm-frame', frame } });
    expect(handleFrame).toHaveBeenCalledTimes(1);
    expect(handleFrame).toHaveBeenCalledWith(frame);

    await settleSwarm(task);
  });
});