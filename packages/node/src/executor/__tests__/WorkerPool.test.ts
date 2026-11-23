import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../WorkerPool';
import { MAX_TASK_RESULT_BYTES } from '../resultLimits';

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    pool?.terminate();
  });

  it('should reject when Worker is not available', async () => {
    const originalWorker = globalThis.Worker;
    (globalThis as any).Worker = undefined;

    pool = new WorkerPool();
    await expect(pool.run('1', 'ai-inference', {})).rejects.toThrow('Worker not available');

    (globalThis as any).Worker = originalWorker;
  });

  it('should reject on timeout', async () => {
    class MockWorker {
      postMessage = vi.fn();
      terminate = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }

    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 10);
    await expect(pool.run('1', 'ai-inference', {})).rejects.toThrow('TIMEOUT');
  });

  it('should resolve when worker returns done', async () => {
    let handler: Function;
    const mockAddEventListener = vi.fn((_event: string, h: Function) => {
      handler = h;
    });

    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => handler({ data: { id: '1', type: 'done', result: { output: 'ok' } } }), 0);
      });
      terminate = vi.fn();
      addEventListener = mockAddEventListener;
      removeEventListener = vi.fn();
    }

    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool();
    const result = await pool.run('1', 'ai-inference', {}, 100);
    expect(result).toEqual({ output: 'ok' });
  });

  it('preempts a speculative preload and retries it after the foreground task', async () => {
    let handler: Function | undefined;
    const terminate = vi.fn();
    let preloadAttempts = 0;
    class MockWorker {
      postMessage = vi.fn((message: { id: string; workload: string }) => {
        if (message.workload === 'ai-preload') {
          preloadAttempts += 1;
          // The first attempt is killed mid-load; the retry completes.
          if (preloadAttempts > 1) {
            setTimeout(
              () => handler?.({ data: { id: message.id, type: 'done', result: { warm: true } } }),
              0,
            );
          }
          return;
        }
        setTimeout(
          () => handler?.({ data: { id: message.id, type: 'done', result: { ok: true } } }),
          0,
        );
      });
      terminate = terminate;
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;
    pool = new WorkerPool();

    const preload = pool.run(
      'preload-1',
      'ai-preload' as any,
      {},
      60_000,
      undefined,
      undefined,
      1,
    );
    const foreground = pool.run('task-1', 'ai-inference', {}, 100);

    await expect(foreground).resolves.toEqual({ ok: true });
    // The warm-up is not dropped: it runs again once the foreground task ends.
    await expect(preload).resolves.toEqual({ warm: true });
    expect(preloadAttempts).toBe(2);
    // Stopping the warm-up is the only way to break a synchronous wasm load.
    expect(terminate).toHaveBeenCalled();
  });

  it('runs equal-priority queued tasks in arrival order', async () => {
    let handler: Function | undefined;
    const started: string[] = [];
    class MockWorker {
      postMessage = vi.fn((message: { id: string; workload: string }) => {
        started.push(message.id);
        setTimeout(
          () => handler?.({ data: { id: message.id, type: 'done', result: { id: message.id } } }),
          0,
        );
      });
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;
    pool = new WorkerPool();

    const results = await Promise.all([
      pool.run('first', 'ai-inference', {}),
      pool.run('second', 'ai-inference', {}),
      pool.run('third', 'image-process', {}),
    ]);

    expect(started).toEqual(['first', 'second', 'third']);
    expect(results.map((result: any) => result.id)).toEqual(['first', 'second', 'third']);
  });

  it('distinguishes an unobserved CPU load from a measured zero', async () => {
    let handler: Function;
    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => {
          handler({ data: { id: 'cpu', type: 'heartbeat', cpuLoad: 0 } });
          handler({ data: { id: 'cpu', type: 'done', result: { output: 'ok' } } });
        }, 0);
      });
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, listener: Function) => { handler = listener; });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;
    pool = new WorkerPool();

    expect(pool.hasCpuLoadSample).toBe(false);
    await pool.run('cpu', 'ai-inference', {}, 100);
    expect(pool.hasCpuLoadSample).toBe(true);
    expect(pool.lastCpuLoad).toBe(0);
  });

  it('retains only a fresh validated executable model snapshot and clears it on terminate', async () => {
    let handler: Function;
    const now = Date.now();
    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => {
          handler({ data: {
            id: 'cache',
            type: 'heartbeat',
            modelCache: {
              version: 1,
              sampledAt: now,
              expiresAt: now + 60_000,
              entries: [{ modelId: 'm', revision: 'r1', dtype: 'q4f16', backend: 'wasm', state: 'ready', referenceCount: 1 }],
            },
          } });
          handler({ data: { id: 'cache', type: 'done', result: {} } });
        }, 0);
      });
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, listener: Function) => { handler = listener; });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;
    pool = new WorkerPool();

    await pool.run('cache', 'ai-inference', {}, 100);
    expect(pool.modelCacheSnapshot?.entries[0]).toMatchObject({ modelId: 'm', state: 'ready', referenceCount: 1 });
    pool.terminate();
    expect(pool.modelCacheSnapshot).toBeNull();
  });

  it('should reject when worker returns error', async () => {
    let handler: Function;
    const mockAddEventListener = vi.fn((_event: string, h: Function) => {
      handler = h;
    });

    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => handler({ data: { id: '1', type: 'error', error: 'Something failed' } }), 0);
      });
      terminate = vi.fn();
      addEventListener = mockAddEventListener;
      removeEventListener = vi.fn();
    }

    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool();
    await expect(pool.run('1', 'ai-inference', {}, 100)).rejects.toThrow('Something failed');
  });

  it('should ignore messages with different id', async () => {
    let handler: Function;
    const mockAddEventListener = vi.fn((_event: string, h: Function) => {
      handler = h;
    });

    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => {
          handler({ data: { id: 'wrong-id', type: 'done', result: { output: 'ignored' } } });
          handler({ data: { id: '1', type: 'done', result: { output: 'correct' } } });
        }, 0);
      });
      terminate = vi.fn();
      addEventListener = mockAddEventListener;
      removeEventListener = vi.fn();
    }

    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool();
    const result = await pool.run('1', 'ai-inference', {}, 100);
    expect(result).toEqual({ output: 'correct' });
  });

  it('drops a queued task when the coordinator aborts it', async () => {
    const postMessage = vi.fn();
    class MockWorker {
      postMessage = postMessage;
      terminate = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 5000);
    // Task 1 never reports back, so task 2 sits in the queue behind it.
    void pool.run('1', 'ai-inference', {}).catch(() => {});
    const queued = pool.run('2', 'image-process', {});

    expect(pool.abort('2', 'peer failed')).toBe(true);
    await expect(queued).rejects.toThrow('peer failed');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    expect(pool.abort('never-queued', 'peer failed')).toBe(false);
  });

  it('keeps the worker slot until an aborted task reports back', async () => {
    let handler: Function;
    const postMessage = vi.fn();
    class MockWorker {
      postMessage = postMessage;
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 5000);
    const active = pool.run('1', 'ai-inference', {});

    expect(pool.abort('1', 'peer failed')).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ id: '1', type: 'abort', reason: 'peer failed' });

    // The slot is still held: releasing it here would let task 2 run in the
    // same worker as task 1.
    const queued = pool.run('2', 'image-process', {});
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));

    // The worker's own report settles task 1 and only then starts task 2.
    handler!({ data: { id: '1', type: 'error', error: 'peer failed' } });
    await expect(active).rejects.toThrow('peer failed');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: '2', workload: 'image-process' }));

    void queued.catch(() => {});
  });

  it('rejects a duplicate task id while it is already in flight', async () => {
    class MockWorker {
      postMessage = vi.fn();
      terminate = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 5000);
    void pool.run('1', 'ai-inference', {}).catch(() => {});

    await expect(pool.run('1', 'ai-inference', {})).rejects.toThrow(/already has task 1/);
  });

  it('rejects new tasks once the queue is full', async () => {
    class MockWorker {
      postMessage = vi.fn();
      terminate = vi.fn();
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool(undefined, 5000);
    void pool.run('1', 'ai-inference', {}).catch(() => {});
    for (let id = 2; id <= 17; id++) {
      void pool.run(String(id), 'ai-inference', {}).catch(() => {});
    }

    await expect(pool.run('18', 'ai-inference', {})).rejects.toThrow(/queue is full/);
  });

  it('rejects an oversized result on the main thread instead of resolving it', async () => {
    let handler: Function;
    class MockWorker {
      postMessage = vi.fn(() => {
        setTimeout(() => {
          handler({ data: { id: '1', type: 'done', result: { imageBase64: 'x'.repeat(MAX_TASK_RESULT_BYTES) } } });
        }, 0);
      });
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }
    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool();
    await expect(pool.run('1', 'image-process', {}, 100)).rejects.toThrow(/exceeds the .* byte limit/);
  });
});
