/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Task lifecycle: expiry of unassigned tasks, retention of settled records, and
 * callback delivery retries.
 *
 * A task nobody ever picked up used to sit in `pending` forever — keeping the
 * alarm (and its billing) armed every 30s with no way out — a settled record
 * was never collected, and a callback the receiver rejected was swallowed as if
 * it had arrived, so the verdict was lost for good.
 */
import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { TaskRecord } from '@flaxia/sdk';
import { CALLBACK_MAX_ATTEMPTS, CALLBACK_QUEUE_LIMIT, TASK_RETENTION_MS } from '../Coordinator';

interface NodeRecord {
  id: string;
  status: 'idle' | 'busy';
  capabilities: string[];
  cpuLoad: number;
  connectedAt: number;
  lastPongAt: number;
  currentTaskId?: string;
}

let stub: DurableObjectStub;
let coordinatorCounter = 0;

function newStub(): DurableObjectStub {
  coordinatorCounter++;
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(`lifecycle-coordinator-${coordinatorCounter}`));
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: crypto.randomUUID(),
    status: 'pending',
    workload: 'ai-inference',
    payload: { task: 'text-generation', model: 'test-model', input: 'hi' },
    createdAt: Date.now(),
    retryCount: 0,
    timeoutMs: 60000,
    ...overrides,
  } as TaskRecord;
}

async function withStorage<T>(fn: (storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as any).ctx.storage));
}

async function runAlarm(): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    (instance as any).pendingCache = null;
    (instance as any).processingCache = null;
    await (instance as any).alarm();
  });
}

async function getTask(id: string): Promise<TaskRecord> {
  return stub.fetch(`http://internal/task/${id}`).then((r) => r.json() as Promise<TaskRecord>);
}

/** Seed a task that has been waiting in the queue, with nothing to run it. */
async function seedPendingTask(task: TaskRecord): Promise<void> {
  await withStorage(async (storage) => {
    await storage.put(`task:${task.id}`, task);
    await storage.put('queue:pending', [task.id]);
    await storage.put('queue:processing', []);
    await storage.put('nodes:idle', []);
  });
}

async function seedProcessingTask(task: TaskRecord, node: NodeRecord): Promise<void> {
  await withStorage(async (storage) => {
    await storage.put(`task:${task.id}`, task);
    await storage.put(`node:${node.id}`, node);
    await storage.put('queue:pending', []);
    await storage.put('queue:processing', [task.id]);
    await storage.put('nodes:idle', []);
  });
}

/**
 * Answer the next callback POSTs with the given statuses, in order; returns the
 * bodies actually sent.
 */
function mockCallback(path: string, statuses: number[]): string[] {
  const pool = fetchMock.get('https://hooks.example.com');
  const bodies: string[] = [];
  for (const status of statuses) {
    pool.intercept({ path, method: 'POST' })
      .reply((opts) => {
        bodies.push(String(opts.body));
        return { statusCode: status, data: status === 200 ? 'ok' : 'rejected' };
      })
      .times(1);
  }
  return bodies;
}

/** Pretend the callback's backoff has elapsed so the next alarm retries it. */
async function clearCallbackBackoff(): Promise<void> {
  await withStorage(async (storage) => {
    const queue = (await storage.get<string[]>('queue:callbacks')) ?? [];
    if (queue.length === 0) return;
    const entry = await storage.get<any>(`callback:${queue[0]}`);
    await storage.put(`callback:${queue[0]}`, { ...entry, nextAttemptAt: 0 });
  });
}

describe('unassigned pending tasks', () => {
  it('fails the task, notifies the callback, and collects the record after retention', async () => {
    stub = newStub();
    fetchMock.activate();
    const bodies = mockCallback('/crowd', [200]);

    const task = makeTask({
      createdAt: Date.now() - 120000,
      timeoutMs: 60000,
      callbackUrl: 'https://hooks.example.com/crowd',
    });
    await seedPendingTask(task);

    await runAlarm();

    const failed = await getTask(task.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('task_timeout_unassigned');
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({
      taskId: task.id,
      status: 'failed',
      error: 'task_timeout_unassigned',
    });

    await withStorage(async (storage) => {
      expect(await storage.get<string[]>('queue:pending')).toEqual([]);
      // Still readable through GET /crowd/tasks/:id.
      expect(await storage.get(`task:${task.id}`)).toBeTruthy();
    });

    // Age the record past its retention window.
    await withStorage(async (storage) => {
      const record = await storage.get<TaskRecord>(`task:${task.id}`);
      await storage.put(`task:${task.id}`, {
        ...record!,
        completedAt: Date.now() - TASK_RETENTION_MS - 1,
      });
      await storage.deleteAlarm();
    });
    await runAlarm();

    await withStorage(async (storage) => {
      expect(await storage.get(`task:${task.id}`)).toBeUndefined();
      // Nothing left to expire or collect: the alarm must not re-arm.
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it('leaves a task that is still inside its timeout window queued', async () => {
    stub = newStub();
    const task = makeTask({ createdAt: Date.now() - 1000, timeoutMs: 60000 });
    await seedPendingTask(task);

    await runAlarm();

    const queued = await getTask(task.id);
    expect(queued.status).toBe('pending');
    await withStorage(async (storage) => {
      expect(await storage.get<string[]>('queue:pending')).toEqual([task.id]);
      // The task is still work in progress, so the alarm stays armed.
      expect(await storage.getAlarm()).not.toBeNull();
    });
  });

  it('does not fail the task in the same pass that requeues it for a retry', async () => {
    stub = newStub();
    const task = makeTask({
      status: 'processing',
      assignedNodeId: 'node-1',
      assignedAt: Date.now() - 90000,
      createdAt: Date.now() - 95000,
      timeoutMs: 60000,
    });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    await runAlarm();

    const requeued = await getTask(task.id);
    expect(requeued.status).toBe('pending');
    expect(requeued.retryCount).toBe(1);
  });
});

describe('callback retries', () => {
  it('retries a callback the receiver rejected and stops once it is accepted', async () => {
    stub = newStub();
    fetchMock.activate();
    const bodies = mockCallback('/retry', [500, 200]);

    const task = makeTask({
      createdAt: Date.now() - 120000,
      callbackUrl: 'https://hooks.example.com/retry',
    });
    await seedPendingTask(task);

    await runAlarm();

    expect(bodies).toHaveLength(1);
    let queued: string[] = [];
    await withStorage(async (storage) => {
      queued = (await storage.get<string[]>('queue:callbacks')) ?? [];
      expect(queued).toHaveLength(1);
      const entry = await storage.get<any>(`callback:${queued[0]}`);
      expect(entry).toMatchObject({ url: 'https://hooks.example.com/retry', attempts: 1 });
      expect(entry.nextAttemptAt).toBeGreaterThan(Date.now());
    });

    // The backoff is measured in seconds; pretend it has elapsed.
    await clearCallbackBackoff();
    await runAlarm();

    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[1])).toMatchObject({ taskId: task.id, status: 'failed' });
    await withStorage(async (storage) => {
      expect(await storage.get<string[]>('queue:callbacks')).toEqual([]);
      expect(await storage.get(`callback:${queued[0]}`)).toBeUndefined();
    });
  });

  it('gives up after the maximum number of attempts and logs the loss', async () => {
    stub = newStub();
    fetchMock.activate();
    const bodies = mockCallback('/dead', new Array<number>(CALLBACK_MAX_ATTEMPTS + 2).fill(500));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const task = makeTask({
      createdAt: Date.now() - 120000,
      callbackUrl: 'https://hooks.example.com/dead',
    });
    await seedPendingTask(task);

    // The first attempt fails and parks the callback; the alarm retries it.
    await runAlarm();
    for (let i = 0; i < CALLBACK_MAX_ATTEMPTS; i++) {
      await clearCallbackBackoff();
      await runAlarm();
    }

    expect(bodies).toHaveLength(CALLBACK_MAX_ATTEMPTS);
    expect(error).toHaveBeenCalled();
    await withStorage(async (storage) => {
      expect(await storage.get<string[]>('queue:callbacks')).toEqual([]);
    });
    error.mockRestore();
  });

  it('drops the oldest callback once the retry queue is full', async () => {
    stub = newStub();
    fetchMock.activate();
    mockCallback('/full', [500]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ids = Array.from({ length: CALLBACK_QUEUE_LIMIT }, (_, i) => `cb-${i}`);
    await withStorage(async (storage) => {
      for (let i = 0; i < ids.length; i += 100) {
        const entries: Record<string, unknown> = {};
        for (const id of ids.slice(i, i + 100)) {
          entries[`callback:${id}`] = {
            url: 'https://hooks.example.com/full',
            body: { taskId: id, status: 'failed' },
            attempts: 1,
            nextAttemptAt: 0,
          };
        }
        await storage.put(entries);
      }
      await storage.put('queue:callbacks', ids);
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as any).deliverCallback('https://hooks.example.com/full', { taskId: 'new', status: 'failed' });
    });

    await withStorage(async (storage) => {
      const queue = (await storage.get<string[]>('queue:callbacks')) ?? [];
      expect(queue).toHaveLength(CALLBACK_QUEUE_LIMIT);
      expect(queue).not.toContain(ids[0]);
      expect(queue).toContain(ids[ids.length - 1]);
      expect(await storage.get(`callback:${ids[0]}`)).toBeUndefined();
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
