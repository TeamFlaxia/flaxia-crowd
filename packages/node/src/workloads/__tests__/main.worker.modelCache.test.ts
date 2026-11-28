import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// main.worker snapshot behavior for the LoRA expert workload: the base and the
// adapter share a manifest id, so only the adapter id distinguishes them.
const { mocks } = vi.hoisted(() => ({
  mocks: {
    snapshotEntries: [] as any[],
    handleTheiaInference: vi.fn(),
    releaseCache: vi.fn(),
    waitForSlot: vi.fn(),
  },
}));

vi.mock('../../executor/memoryProbe', () => ({
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES: 2 * 1024 ** 3,
  probeMaxWasmMemoryBytes: () => 4 * 1024 ** 3,
  hasEnoughWasmMemoryForHeavy: () => true,
}));

// A deterministic throttle: the eviction tests drive time with fake timers, so
// the real rolling-window scheduler would only add unrelated sleeps.
vi.mock('../../executor/throttle', () => ({
  DEFAULT_WAIT_SLOT_MS: 30_000,
  ThrottleBusyError: class ThrottleBusyError extends Error {},
  CpuThrottle: class {
    lastMeasuredLoad = 0;
    waitForSlot = (...args: unknown[]) => mocks.waitForSlot(...args);
    beginWork(): void {}
    markTaskComplete(): void {}
    async yieldIfOverloaded(): Promise<number> { return 0; }
  },
}));

vi.mock('../theia', () => ({
  handleTheiaInference: (...args: unknown[]) => mocks.handleTheiaInference(...args),
  releaseCache: (...args: unknown[]) => mocks.releaseCache(...args),
  getModelCacheSnapshot: () => ({
    version: 1,
    sampledAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    entries: mocks.snapshotEntries,
  }),
}));

// Workload that does not register a snapshotter, used to verify that eviction
// does not wipe the snapshotters registered by earlier tasks.
vi.mock('../cc-extract', () => ({
  handleCcExtract: async () => ({ extracted: true }),
}));

async function bootWorker(posts: any[]) {
  const selfObj: any = { postMessage: (message: any) => posts.push(message) };
  Object.defineProperty(globalThis, 'self', { value: selfObj, configurable: true });
  vi.resetModules();
  await import('../../worker/main.worker');
  return selfObj;
}

function cacheEntry() {
  return {
    modelId: 'test-dllm',
    revision: 'base',
    dtype: 'q4_0',
    backend: 'wasm',
    state: 'ready',
    referenceCount: 1,
  };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let the async onmessage handler reach the (mocked) workload call. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('main.worker theia model cache', () => {
  it('keeps an adapter entry distinct from the base entry when deduping', async () => {
    const entries = [
      {
        modelId: 'test-dllm',
        revision: 'base',
        dtype: 'q4_0',
        backend: 'wasm',
        state: 'ready',
        referenceCount: 1,
      },
      {
        modelId: 'test-dllm',
        revision: 'adapter',
        dtype: 'q4_0',
        backend: 'wasm',
        state: 'ready',
        referenceCount: 1,
        adapterId: 'code',
      },
    ];
    mocks.snapshotEntries = entries;
    mocks.handleTheiaInference.mockReset().mockResolvedValue({ output: 'ok' });

    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({
      data: { id: 'theia-1', workload: 'theia-inference', payload: { messages: [], model: 'm' } },
    });

    const done = posts.find((message) => message.type === 'done');
    expect(done).toBeDefined();
    expect(done.modelCache.entries).toEqual(entries);
  });

  it('reports an unconfigured expert as a permanent task failure', async () => {
    mocks.snapshotEntries = [];
    mocks.handleTheiaInference
      .mockReset()
      .mockRejectedValue(new Error("theia-inference: no adapter pin for expert 'code'"));

    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({
      data: { id: 'theia-2', workload: 'theia-inference', payload: { messages: [], model: 'm' } },
    });

    const error = posts.find((message) => message.type === 'error');
    expect(error).toBeDefined();
    expect(String(error.error)).toMatch(/no adapter pin for expert/);
    expect(error.permanent).toBe(true);
  });
});

describe('main.worker idle cache eviction', () => {
  // The worker keeps the eviction callback in a module-local timer. Wrapping
  // setTimeout lets the tests also fire a stale callback on demand, simulating
  // a timer that won a race with an incoming task.
  let evictionCallbacks: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    const fakeSetTimeout = globalThis.setTimeout;
    evictionCallbacks = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      (handler: () => void, timeout?: number, ...args: unknown[]) => {
        if (timeout === 60_000) evictionCallbacks.push(handler);
        return fakeSetTimeout(handler, timeout, ...args);
      }
    ) as typeof setTimeout);
    mocks.snapshotEntries = [];
    mocks.releaseCache.mockReset();
    mocks.waitForSlot.mockReset().mockResolvedValue(undefined);
    mocks.handleTheiaInference.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('cancels the armed eviction timer when a task starts', async () => {
    mocks.snapshotEntries = [cacheEntry()];
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const posts: any[] = [];
    const selfObj = await bootWorker(posts);

    // A completed task arms the 60s idle timer.
    await selfObj.onmessage({ data: { id: 'warm', workload: 'theia-inference', payload: {} } });
    expect(evictionCallbacks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(mocks.releaseCache).not.toHaveBeenCalled();

    // A new task starts with 1s left on the old timer and stays in flight past
    // its deadline: the stale timer must not evict a running workload's caches.
    const gate = deferred();
    mocks.handleTheiaInference.mockImplementation(() => gate.promise);
    const running = selfObj.onmessage({ data: { id: 'long', workload: 'theia-inference', payload: {} } });
    await flushMicrotasks();
    expect(mocks.handleTheiaInference).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.releaseCache).not.toHaveBeenCalled();

    gate.resolve({ output: 'ok' });
    await running;
  });

  it('does not release caches when a stale eviction callback fires during a task', async () => {
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const selfObj = await bootWorker([]);
    await selfObj.onmessage({ data: { id: 'warm', workload: 'theia-inference', payload: {} } });
    expect(evictionCallbacks).toHaveLength(1);

    const gate = deferred();
    mocks.handleTheiaInference.mockImplementation(() => gate.promise);
    const running = selfObj.onmessage({ data: { id: 'long', workload: 'theia-inference', payload: {} } });
    await flushMicrotasks();

    // Second guard: even a callback that was already queued must stand down
    // while a task is active, and must re-arm for the next idle period.
    evictionCallbacks[0]();
    expect(mocks.releaseCache).not.toHaveBeenCalled();
    expect(evictionCallbacks.length).toBeGreaterThan(1);

    gate.resolve({ output: 'ok' });
    await running;
  });

  it('releases caches 60s after a task completes', async () => {
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const selfObj = await bootWorker([]);
    await selfObj.onmessage({ data: { id: 'one', workload: 'theia-inference', payload: {} } });
    expect(evictionCallbacks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(mocks.releaseCache).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.releaseCache).toHaveBeenCalledTimes(1);
  });

  it('arms eviction after a failure on the outer catch path', async () => {
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    // One successful task registers a releaser; drop its timer so only a
    // re-arm from the failing task can evict these caches.
    await selfObj.onmessage({ data: { id: 'warm', workload: 'theia-inference', payload: {} } });
    vi.clearAllTimers();

    mocks.waitForSlot.mockRejectedValueOnce(new Error('slot gate failed'));
    await selfObj.onmessage({ data: { id: 'fail', workload: 'theia-inference', payload: {} } });
    expect(posts.some((message) => message.type === 'error')).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.releaseCache).toHaveBeenCalledTimes(1);
  });

  it('keeps snapshotters after eviction so later tasks still report warm entries', async () => {
    const entry = cacheEntry();
    mocks.snapshotEntries = [entry];
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({ data: { id: 'first', workload: 'theia-inference', payload: {} } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.releaseCache).toHaveBeenCalledTimes(1);

    // cc-extract registers no snapshotter of its own, so its snapshot can only
    // be non-empty if eviction left the earlier theia snapshotter registered.
    const before = posts.length;
    await selfObj.onmessage({ data: { id: 'second', workload: 'cc-extract', payload: {} } });
    const done = posts.slice(before).find((message) => message.type === 'done');
    expect(done).toBeDefined();
    expect(done.modelCache.entries).toEqual([entry]);
  });

  it('keeps heartbeat entries when a stale eviction callback fires during a task', async () => {
    const entry = cacheEntry();
    mocks.snapshotEntries = [entry];
    mocks.handleTheiaInference.mockResolvedValue({ output: 'ok' });
    const posts: any[] = [];
    const selfObj = await bootWorker(posts);
    await selfObj.onmessage({ data: { id: 'warm', workload: 'theia-inference', payload: {} } });
    expect(evictionCallbacks).toHaveLength(1);

    const gate = deferred();
    mocks.handleTheiaInference.mockImplementation(() => gate.promise);
    const running = selfObj.onmessage({ data: { id: 'long', workload: 'theia-inference', payload: {} } });
    await flushMicrotasks();
    evictionCallbacks[0]();

    await vi.advanceTimersByTimeAsync(10_000);
    const heartbeats = posts.filter((message) => message.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[heartbeats.length - 1].modelCache.entries).toEqual([entry]);

    gate.resolve({ output: 'ok' });
    await running;
  });
});
