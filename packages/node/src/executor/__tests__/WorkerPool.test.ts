import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerPool } from '../WorkerPool';

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

  it('routes swarm frames/messages out and posts control/frames in', async () => {
    let handler: Function;
    const posted: any[] = [];

    class MockWorker {
      postMessage = vi.fn((msg: any, transfer?: Transferable[]) => posted.push({ msg, transfer }));
      terminate = vi.fn();
      addEventListener = vi.fn((_event: string, h: Function) => {
        handler = h;
      });
      removeEventListener = vi.fn();
    }

    (globalThis as any).Worker = MockWorker as any;

    pool = new WorkerPool();
    const messages: unknown[] = [];
    const frames: ArrayBuffer[] = [];
    const pending = pool.run('1', 'swarm-inference', { type: 'swarm-slice' }, 100, undefined, undefined, {
      onMessage: (m) => messages.push(m),
      onFrame: (f) => frames.push(f),
    });

    // The worker is the active slot now, so control and frames can be posted in.
    expect(pool.sendControl({ type: 'swarm-start', sessionId: 's', taskId: '1' })).toBe(true);
    expect(pool.sendFrame(new ArrayBuffer(4))).toBe(true);
    const controlPost = posted.find((p) => p.msg.type === 'swarm-control');
    const framePost = posted.find((p) => p.msg.type === 'swarm-frame');
    expect(controlPost.msg.id).toBe('1');
    expect(framePost.transfer).toHaveLength(1);

    handler!({ data: { id: '1', type: 'swarm-message', message: { type: 'swarm-ready', sessionId: 's' } } });
    handler!({ data: { id: '1', type: 'swarm-frame', frame: new ArrayBuffer(8) } });
    handler!({ data: { id: '1', type: 'done', result: { ok: true } } });

    await expect(pending).resolves.toEqual({ ok: true });
    expect(messages).toEqual([{ type: 'swarm-ready', sessionId: 's' }]);
    expect(frames).toHaveLength(1);
  });
});
