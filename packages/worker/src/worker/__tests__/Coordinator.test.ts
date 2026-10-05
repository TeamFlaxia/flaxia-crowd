import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { SwarmChainNode, TaskRecord } from '@flaxia/sdk';
import { encodeSwarmEnvelope, verifyCrowdWebhook } from '@flaxia/sdk';
import { MAX_PENDING_TASKS, MAX_PENDING_TTL_MS, MAX_RETRIES, MAX_SUBSCRIBERS_PER_TASK } from '../Coordinator';
import { parseSwarmCapabilities, parseWarmModels } from '../../crowd/index';
import { TEST_WEBHOOK_SIGNING_SECRET } from './testSecrets';

interface NodeRecord {
  id: string;
  status: "idle" | "busy";
  capabilities: string[];
  cpuLoad: number;
  connectedAt: number;
  lastPongAt: number;
  currentTaskId?: string;
  siteId?: string;
  assignedCount?: number;
}

const TENANT = 'tenant-test';
const OTHER_TENANT = 'tenant-other';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: crypto.randomUUID(),
    status: 'pending',
    workload: 'ai-inference',
    payload: { task: 'text-generation', model: 'test-model', input: 'hi' },
    createdAt: Date.now(),
    tenantId: TENANT,
    retryCount: 0,
    timeoutMs: 60000,
    ...overrides,
  } as TaskRecord;
}

function taskPath(taskId: string, tenantId = TENANT): string {
  return `http://internal/task/${tenantId}/${taskId}`;
}

let stub: DurableObjectStub;
let coordinatorCounter = 0;

function newStub(): DurableObjectStub {
  coordinatorCounter++;
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(`test-coordinator-${coordinatorCounter}`));
}

async function withStorage<T>(fn: (storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as any).ctx.storage));
}

async function getTask(taskId: string, tenantId = TENANT): Promise<TaskRecord> {
  return stub.fetch(taskPath(taskId, tenantId)).then(r => r.json() as Promise<TaskRecord>);
}

/** Seed task records under their tenant-scoped keys plus the id -> tenant index. */
async function seedTasks(storage: DurableObjectStorage, tasks: TaskRecord[]) {
  for (const task of tasks) {
    await storage.put(`task:${task.tenantId}:${task.id}`, task);
    await storage.put(`taskindex:${task.id}`, task.tenantId);
  }
}

async function seedProcessingTask(task: TaskRecord, node: NodeRecord) {
  await withStorage(async (storage) => {
    await seedTasks(storage, [task]);
    await storage.put(`node:${node.id}`, node);
    await storage.put('queue:pending', []);
    await storage.put('queue:processing', [task.id]);
    await storage.put('nodes:idle', []);
  });
}

/** Seed pending tasks, then expose the scheduler entry point. */
async function seedPending(tasks: TaskRecord[], idleNodes: string[]) {
  await withStorage(async (storage) => {
    await seedTasks(storage, tasks);
    await storage.put('queue:pending', tasks.map(t => t.id));
    await storage.put('queue:processing', []);
    await storage.put('nodes:idle', idleNodes);
  });
}

async function runAssign() {
  await runInDurableObject(stub, async (instance) => {
    (instance as any).pendingCache = null;
    (instance as any).processingCache = null;
    await (instance as any).tryAssignAll();
  });
}

async function runAlarm() {
  await runInDurableObject(stub, async (instance) => {
    (instance as any).pendingCache = null;
    (instance as any).processingCache = null;
    await (instance as any).alarm();
  });
}

describe('Coordinator', () => {
  it('stores a submitted task', async () => {
    stub = newStub();
    const task = makeTask();
    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify(task),
    });
    expect(resp.status).toBe(200);

    const stored = await getTask(task.id);
    expect(stored.id).toBe(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.workload).toBe('ai-inference');
    expect(stored.tenantId).toBe(TENANT);
  });

  it('rejects malformed JSON on enqueue', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: '{ not valid json',
    });
    expect(resp.status).toBe(400);
  });

  it('rejects an enqueue without a tenant', async () => {
    stub = newStub();
    const task = makeTask();
    delete (task as { tenantId?: string }).tenantId;
    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify(task),
    });
    expect(resp.status).toBe(400);
  });

  it('returns 404 for an unknown task', async () => {
    stub = newStub();
    const resp = await stub.fetch(taskPath('does-not-exist'));
    expect(resp.status).toBe(404);
  });

  it('returns 404 when another tenant asks for the task', async () => {
    stub = newStub();
    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    // The owner sees it...
    const owned = await stub.fetch(taskPath(task.id, TENANT));
    expect(owned.status).toBe(200);

    // ...any other tenant gets a 404, not a redacted record. The tenant is part
    // of the storage key, so there is no lookup path that could leak it.
    const foreign = await stub.fetch(taskPath(task.id, OTHER_TENANT));
    expect(foreign.status).toBe(404);
  });

  it('returns 404 when subscribing to an unknown task', async () => {
    stub = newStub();
    const resp = await stub.fetch(`http://internal/subscribe?taskId=does-not-exist&tenantId=${TENANT}`);
    expect(resp.status).toBe(404);
  });

  it('returns 400 when subscribing without taskId', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/subscribe');
    expect(resp.status).toBe(400);
  });

  it('returns 404 when subscribing to another tenant\'s task', async () => {
    stub = newStub();
    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    const resp = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${OTHER_TENANT}`);
    expect(resp.status).toBe(404);
  });

  it('requeues a timed-out processing task and releases its node', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 120000 });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    await runAlarm();

    const updated = await getTask(task.id);
    expect(updated.status).toBe('pending');
    expect(updated.retryCount).toBe(1);
    expect(updated.assignedNodeId).toBeUndefined();

    await withStorage(async (storage) => {
      const released = await storage.get<NodeRecord>('node:node-1');
      expect(released!.status).toBe('idle');
      expect(released!.currentTaskId).toBeUndefined();
      const idle = await storage.get<string[]>('nodes:idle');
      expect(idle).toContain('node-1');
    });
  });

  it('tells the assigned node to stop when a processing task times out', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 120000 });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);
    const connected = await connectNode('node-1', 'capabilities=ai-inference');

    await runAlarm();

    // The node is still running this task; without a stop signal it would hold
    // the slot until its own timeout fired, long after the coordinator requeued
    // the task for someone else.
    const aborts = jsonFrames(connected).filter((f) => f.type === 'abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ taskId: task.id, error: 'Task timed out' });
  });

  it('fails a task permanently once MAX_RETRIES is reached', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 120000, retryCount: MAX_RETRIES });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    await runAlarm();

    const updated = await getTask(task.id);
    expect(updated.status).toBe('failed');
    expect(updated.retryCount).toBe(MAX_RETRIES);
    expect(updated.error).toBe('Task timed out');

    await withStorage(async (storage) => {
      const processing = await storage.get<string[]>('queue:processing');
      expect(processing).toEqual([]);
    });
  });

  it('garbage-collects stale nodes and fails their in-flight tasks', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-stale', assignedAt: Date.now() - 120000, retryCount: MAX_RETRIES });
    const staleNode: NodeRecord = {
      id: 'node-stale', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now() - 120000, currentTaskId: task.id,
    };
    await seedProcessingTask(task, staleNode);

    await runAlarm();

    const failed = await getTask(task.id);
    expect(failed.status).toBe('failed');

    await withStorage(async (storage) => {
      expect(await storage.get('node:node-stale')).toBeUndefined();
    });
  });

  it('does NOT requeue a task when its node reconnects with the task still in flight', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 1000, retryCount: 0 });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    const resp = await stub.fetch('http://internal/ws?nodeId=node-1&capabilities=ai-inference', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(resp.status).toBe(101);

    const after = await getTask(task.id);
    expect(after.status).toBe('processing');
    expect(after.retryCount).toBe(0);
    expect(after.assignedNodeId).toBe('node-1');

    await withStorage(async (storage) => {
      const pending = await storage.get<string[]>('queue:pending');
      expect(pending).not.toContain(task.id);
      const updated = await storage.get<NodeRecord>('node:node-1');
      expect(updated?.currentTaskId).toBe(task.id);
    });
  });

  it('does NOT hand heavy workloads to low-memory nodes', async () => {
    stub = newStub();
    const task = makeTask();

    // A low-memory node advertises the heavy capability, but the coordinator
    // must never route heavy WASM workloads to it.
    await stub.fetch('http://internal/ws?nodeId=node-lm&capabilities=ai-inference&lowMemory=true', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    const enq = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify(task),
    });
    expect(enq.status).toBe(200);

    let stored = await getTask(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();

    // A capable, non-low-memory node can still pick it up immediately.
    await stub.fetch('http://internal/ws?nodeId=node-ok&capabilities=ai-inference', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(stored.assignedNodeId).toBe('node-ok');
  });

  it('never routes swarm-inference to a node without WebGPU', async () => {
    stub = newStub();
    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3-1.7b', prompt: 'hi' } });

    // One node advertises the swarm capability without a WebGPU adapter; two
    // real candidates exist, so the session can start without it.
    const noGpu = await connectNode('node-nogpu', 'capabilities=swarm-inference&wasm=8000000000');
    await connectNode('node-gpu1', 'capabilities=swarm-inference&webgpu=true&wasm=4000000000');
    await connectNode('node-gpu2', 'capabilities=swarm-inference&webgpu=true&wasm=2000000000');

    await seedPending([task], ['node-nogpu', 'node-gpu1', 'node-gpu2']);

    await runAssign();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(['node-gpu1', 'node-gpu2']).toContain(stored.assignedNodeId);
    expect(jsonFrames(noGpu).some(f => f.type === 'swarm-init')).toBe(false);
  });

  it('stores advertised WebGPU and warm-model capabilities', async () => {
    stub = newStub();
    const warm = JSON.stringify([{ modelId: 'qwen3-1.7b', layers: [0, 13] }]);

    const resp = await stub.fetch(
      `http://internal/ws?nodeId=node-cap&capabilities=swarm-inference&webgpu=true&gpu=apple%20m1&maxBuffer=134217728&warmModels=${encodeURIComponent(warm)}&site=example.com`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } },
    );
    expect(resp.status).toBe(101);

    interface StoredNode {
      webgpu?: boolean;
      gpuArchitecture?: string;
      maxStorageBufferBindingSize?: number;
      warmModels?: unknown;
      siteId?: string;
    }

    await withStorage(async (storage) => {
      const node = await storage.get<StoredNode>('node:node-cap');
      expect(node?.webgpu).toBe(true);
      expect(node?.gpuArchitecture).toBe('apple m1');
      expect(node?.maxStorageBufferBindingSize).toBe(134217728);
      expect(node?.warmModels).toEqual([{ modelId: 'qwen3-1.7b', layers: [0, 13] }]);
      expect(node?.siteId).toBe('example.com');
    });
  });

  it('delivers a task frame carrying a fresh attempt id', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/ws?nodeId=n1&capabilities=ai-inference', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(resp.status).toBe(101);
    const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();
    const messages: string[] = [];
    socket!.addEventListener('message', (e: MessageEvent) => messages.push(String(e.data)));

    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
    await new Promise((r) => setTimeout(r, 50));

    const frames = messages.map((m) => JSON.parse(m));
    const delivery = frames.find((f) => f.type === 'task' && f.taskId === task.id);
    expect(delivery).toBeTruthy();
    expect(typeof delivery.attemptId).toBe('string');
    expect(delivery.attemptId.length).toBeGreaterThan(0);
  });

  it('rate limits unauthenticated websocket routes per IP in storage', async () => {
    stub = newStub();
    let got429 = false;
    for (let i = 0; i < 110; i++) {
      const resp = await stub.fetch('http://internal/ws', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      });
      if (resp.status === 429) {
        got429 = true;
        break;
      }
      expect(resp.status).toBe(400); // missing nodeId passes rate limit, then 400
    }
    expect(got429).toBe(true);
  });

  // --- #6: queue and fan-out DoS bounds ---

  it('rejects an enqueue once the global pending cap is reached', async () => {
    stub = newStub();
    await withStorage(async (storage) => {
      await storage.put('queue:pending', Array.from({ length: MAX_PENDING_TASKS }, (_, i) => `filler-${i}`));
    });

    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify(makeTask()),
    });
    expect(resp.status).toBe(429);
  });

  it('rejects an enqueue once the tenant pending cap is reached', async () => {
    stub = newStub();
    const task = makeTask();
    await withStorage(async (storage) => {
      await storage.put(`pending:${TENANT}`, Array.from({ length: 50 }, (_, i) => `filler-${i}`));
    });

    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify(task),
    });
    expect(resp.status).toBe(429);
  });

  it('rate limits enqueues per tenant', async () => {
    stub = newStub();
    let got429 = false;
    for (let i = 0; i < 70; i++) {
      const resp = await stub.fetch('http://internal/enqueue', {
        method: 'POST',
        body: JSON.stringify(makeTask()),
      });
      if (resp.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  });

  it('schedules an alarm no later than the pending TTL', async () => {
    stub = newStub();
    // A task may ask for an hour-long timeout, but a task nobody picks up must
    // still be swept after the pending TTL, so the alarm has to be set for the
    // earlier of the two deadlines.
    const task = makeTask({ timeoutMs: 3600000 });
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    const alarm = await withStorage((storage) => storage.getAlarm());
    expect(alarm).toBeTruthy();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + MAX_PENDING_TTL_MS + 1000);
  });

  it('fails a pending task that outlives the pending TTL', async () => {
    stub = newStub();
    const task = makeTask({ createdAt: Date.now() - MAX_PENDING_TTL_MS - 1000 });
    await seedPending([task], []);

    await runAlarm();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatch(/deadline/);
  });

  it('fails a pending task whose site allow-list no node matches', async () => {
    stub = newStub();
    const task = makeTask({
      payload: { task: 'text-generation', model: 'm', input: 'hi', allowedSites: ['trusted.example'] } as TaskRecord['payload'],
      allowedSites: ['trusted.example'],
      createdAt: Date.now() - MAX_PENDING_TTL_MS - 1000,
    });
    await seedPending([task], []);

    await runAlarm();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatch(/requested sites/);
  });

  it('caps concurrent subscribers per task', async () => {
    stub = newStub();
    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    for (let i = 0; i < MAX_SUBSCRIBERS_PER_TASK; i++) {
      const resp = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      expect(resp.status).toBe(101);
      const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket!;
      socket.accept();
    }

    const overflow = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(overflow.status).toBe(429);
  });

  it('rate limits subscribe upgrades per task', async () => {
    stub = newStub();
    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    let got429 = false;
    for (let i = 0; i < 60; i++) {
      const resp = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      if (resp.status === 429) {
        got429 = true;
        break;
      }
      const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket;
      socket?.accept();
      socket?.close();
    }
    expect(got429).toBe(true);
  });

  // --- #3: site allow-list ---

  it('only assigns a site-restricted task to a node registered for that site', async () => {
    stub = newStub();
    await connectNode('node-other', 'capabilities=ai-inference&site=other.example');
    await connectNode('node-trusted', 'capabilities=ai-inference&site=trusted.example');

    const task = makeTask({
      payload: { task: 'text-generation', model: 'm', input: 'hi', allowedSites: ['trusted.example'] } as TaskRecord['payload'],
      allowedSites: ['trusted.example'],
    });
    await seedPending([task], ['node-other', 'node-trusted']);

    await runAssign();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(stored.assignedNodeId).toBe('node-trusted');
  });

  it('leaves a site-restricted task pending when no matching node is connected', async () => {
    stub = newStub();
    await connectNode('node-other', 'capabilities=ai-inference&site=other.example');

    const task = makeTask({ allowedSites: ['trusted.example'] });
    await seedPending([task], ['node-other']);

    await runAssign();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();
  });

  // --- #4: result authenticity ---

  it('ignores a result that carries no attempt id', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    expect(node.frames.length).toBeGreaterThan(0);

    node.socket.send(JSON.stringify({ type: 'result', taskId: task.id, payload: { output: 'forged' } }));
    await new Promise(r => setTimeout(r, 30));

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(stored.result).toBeUndefined();
  });

  it('ignores a result that carries a foreign attempt id', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');

    node.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, payload: { output: 'forged' }, attemptId: crypto.randomUUID(),
    }));
    await new Promise(r => setTimeout(r, 30));

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
  });

  it('retires the previous attempt when a task is redelivered on reconnect', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const firstAttempt = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;

    // The node reconnects: the task is redelivered with a new attempt id and the
    // old attempt must no longer be able to settle it.
    const replacement = await connectNode('node-1', 'capabilities=ai-inference');
    await new Promise(r => setTimeout(r, 30));
    const secondAttempt = jsonFrames(replacement).find(f => f.type === 'task')!.attemptId as string;
    expect(secondAttempt).not.toBe(firstAttempt);

    replacement.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, payload: { output: 'stale' }, attemptId: firstAttempt,
    }));
    await new Promise(r => setTimeout(r, 30));
    expect((await getTask(task.id)).status).toBe('processing');

    replacement.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, payload: { output: 'ok' }, attemptId: secondAttempt,
    }));
    await new Promise(r => setTimeout(r, 30));
    const stored = await getTask(task.id);
    expect(stored.status).toBe('done');
    expect(stored.result).toEqual({ output: 'ok' });
    expect(stored.resultNodeId).toBe('node-1');
    expect(stored.resultAttemptId).toBe(secondAttempt);
  });

  it('ignores a malformed or oversized result without settling the task', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;

    node.socket.send(JSON.stringify({ type: 'result', taskId: task.id, payload: 'not-an-object', attemptId }));
    node.socket.send(JSON.stringify({ type: 'result', taskId: task.id, payload: [1, 2, 3], attemptId }));
    node.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, payload: { output: 'x'.repeat(5 * 1024 * 1024) }, attemptId,
    }));
    await new Promise(r => setTimeout(r, 60));

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(stored.result).toBeUndefined();
  });

  // --- #13: signed webhook deliveries ---

  it('never follows a webhook redirect into a private service', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-redirect');
    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;
    await withStorage(async (storage) => {
      const record = await storage.get<TaskRecord>(`task:${TENANT}:${task.id}`);
      record!.callbackUrl = 'https://hooks.example/redirect';
      await storage.put(`task:${TENANT}:${task.id}`, record!);
    });
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get('https://hooks.example')
      .intercept({ path: '/redirect', method: 'POST' })
      .reply(302, '', { headers: { location: 'http://127.0.0.1/admin' } });
    node.socket.send(JSON.stringify({ type: 'result', taskId: task.id, payload: { output: 'ok' }, attemptId }));
    await new Promise(r => setTimeout(r, 100));
    try {
      fetchMock.assertNoPendingInterceptors();
      expect((await getTask(task.id)).status).toBe('done');
    } finally {
      fetchMock.deactivate();
    }
  });

  it('signs a webhook delivery with the dedicated secret and the audit ids', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;
    await withStorage(async (storage) => {
      const record = await storage.get<TaskRecord>(`task:${TENANT}:${task.id}`);
      record!.callbackUrl = 'https://hooks.example/crowd';
      await storage.put(`task:${TENANT}:${task.id}`, record!);
    });

    let captured: { headers?: Record<string, string>; body?: string } | undefined;
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get('https://hooks.example')
      .intercept({ path: '/crowd', method: 'POST' })
      .reply(200, (options) => {
        captured = options as { headers?: Record<string, string>; body?: string };
        return 'ok';
      });

    node.socket.send(JSON.stringify({ type: 'result', taskId: task.id, payload: { output: 'ok' }, attemptId }));
    await new Promise(r => setTimeout(r, 100));
    try {
      fetchMock.assertNoPendingInterceptors();
    } finally {
      // Never leave net-connect disabled for the tests that follow.
      fetchMock.deactivate();
    }

    const headers = captured?.headers ?? {};
    const signature = headers['x-flaxia-signature'];
    expect(signature).toMatch(/^sha256=/);
    expect(headers['x-flaxia-timestamp']).toBeTruthy();
    expect(headers['x-flaxia-nonce']).toBeTruthy();

    // The receiver can verify the delivery with the SDK helper, and the body
    // records which node and attempt produced the value.
    const body = captured?.body ?? '';
    const verified = await verifyCrowdWebhook({
      secret: TEST_WEBHOOK_SIGNING_SECRET,
      body,
      signature,
      timestamp: headers['x-flaxia-timestamp'],
      nonce: headers['x-flaxia-nonce'],
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.taskId).toBe(task.id);
      expect(verified.payload.result).toEqual({ output: 'ok' });
    }
    expect(JSON.parse(body)).toMatchObject({ taskId: task.id, status: 'done', nodeId: 'node-1', attemptId });
  });

  // --- #10: heartbeat load is self-reported ---

  it('keeps the previous load when a pong reports a malformed cpuLoad', async () => {
    stub = newStub();
    const node = await connectNode('node-1', 'capabilities=ai-inference');
    await withStorage(async (storage) => {
      const record = await storage.get<NodeRecord>('node:node-1');
      record!.cpuLoad = 0.5;
      await storage.put('node:node-1', record!);
    });

    node.socket.send(JSON.stringify({ type: 'pong', cpuLoad: 'zero' }));
    node.socket.send(JSON.stringify({ type: 'pong', cpuLoad: null }));
    await new Promise(r => setTimeout(r, 30));

    await withStorage(async (storage) => {
      // A malformed value must not be coerced to 0, which is the best score a
      // node could report and would let it win every assignment.
      expect((await storage.get<NodeRecord>('node:node-1'))!.cpuLoad).toBe(0.5);
    });
  });

  it('does not let a node that claims zero load monopolize assignments', async () => {
    stub = newStub();
    const liar = await connectNode('node-liar', 'capabilities=ai-inference');
    const honest = await connectNode('node-honest', 'capabilities=ai-inference');
    await withStorage(async (storage) => {
      const liarRecord = await storage.get<NodeRecord>('node:node-liar');
      liarRecord!.cpuLoad = 0;
      await storage.put('node:node-liar', liarRecord!);
      const honestRecord = await storage.get<NodeRecord>('node:node-honest');
      honestRecord!.cpuLoad = 0.5;
      await storage.put('node:node-honest', honestRecord!);
    });

    const first = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(first) });
    await new Promise(r => setTimeout(r, 30));
    expect((await getTask(first.id)).assignedNodeId).toBe('node-liar');

    // The liar finishes the first task (fresh attempt id) and goes idle again
    // with one assignment on record; the honest node must get the next one.
    const attemptId = jsonFrames(liar).find(f => f.type === 'task')!.attemptId as string;
    liar.socket.send(JSON.stringify({ type: 'result', taskId: first.id, payload: { output: 'ok' }, attemptId }));
    await new Promise(r => setTimeout(r, 30));

    const second = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(second) });
    await new Promise(r => setTimeout(r, 30));
    expect((await getTask(second.id)).assignedNodeId).toBe('node-honest');
    expect(jsonFrames(honest).some(f => f.type === 'task' && f.taskId === second.id)).toBe(true);
  });
});

describe('node capability parsing', () => {
  describe('parseSwarmCapabilities', () => {
    it('accepts a minimal webgpu capability', () => {
      expect(parseSwarmCapabilities({ webgpu: true })).toEqual({ webgpu: true });
    });

    it('keeps architecture and buffer limit when present', () => {
      expect(
        parseSwarmCapabilities({ webgpu: true, gpuArchitecture: 'apple m1', maxStorageBufferBindingSize: 134217728 }),
      ).toEqual({ webgpu: true, gpuArchitecture: 'apple m1', maxStorageBufferBindingSize: 134217728 });
    });

    it('rejects malformed payloads', () => {
      expect(parseSwarmCapabilities(undefined)).toBeUndefined();
      expect(parseSwarmCapabilities(null)).toBeUndefined();
      expect(parseSwarmCapabilities('webgpu')).toBeUndefined();
      expect(parseSwarmCapabilities({ webgpu: 'yes' })).toBeUndefined();
      expect(parseSwarmCapabilities({})).toBeUndefined();
    });

    it('drops non-finite and non-string optional fields', () => {
      expect(parseSwarmCapabilities({ webgpu: false, gpuArchitecture: 42, maxStorageBufferBindingSize: NaN })).toEqual({
        webgpu: false,
      });
    });

    it('clamps an absurd self-reported buffer size instead of rejecting it', () => {
      // 1e300 would otherwise win every swarm host election.
      const parsed = parseSwarmCapabilities({ webgpu: true, maxStorageBufferBindingSize: 1e300 });
      expect(parsed?.maxStorageBufferBindingSize).toBe(16 * 1024 ** 3);
    });
  });

  describe('parseWarmModels', () => {
    it('accepts well-formed ranges', () => {
      expect(parseWarmModels([{ modelId: 'qwen3-1.7b', layers: [0, 13] }])).toEqual([
        { modelId: 'qwen3-1.7b', layers: [0, 13] },
      ]);
    });

    it('drops malformed entries but keeps valid ones', () => {
      expect(
        parseWarmModels([
          { modelId: 'ok', layers: [2, 9] },
          { modelId: '', layers: [0, 1] },
          { modelId: 'reversed', layers: [9, 2] },
          { modelId: 'negative', layers: [-1, 4] },
          { modelId: 'floats', layers: [0.5, 4] },
          { modelId: 'missing-layers' },
          'nope',
        ]),
      ).toEqual([{ modelId: 'ok', layers: [2, 9] }]);
    });

    it('rejects empty and absurdly deep ranges', () => {
      // `[0, 0]` is not a span, and `[0, 1e9]` would mark a node warm for any
      // model at all (and drive the swarm split with a fake capacity).
      expect(parseWarmModels([{ modelId: 'empty', layers: [0, 0] }])).toBeUndefined();
      expect(parseWarmModels([{ modelId: 'huge', layers: [0, 1e9] }])).toBeUndefined();
    });

    it('returns undefined when nothing valid remains', () => {
      expect(parseWarmModels([])).toBeUndefined();
      expect(parseWarmModels('nope')).toBeUndefined();
      expect(parseWarmModels([{ modelId: 'bad' }])).toBeUndefined();
    });
  });
});

interface SwarmSocket {
  socket: WebSocket;
  frames: Array<string | ArrayBuffer>;
}

async function connectNode(nodeId: string, query: string): Promise<SwarmSocket> {
  const resp = await stub.fetch(`http://internal/ws?nodeId=${nodeId}&${query}`, {
    headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
  });
  expect(resp.status).toBe(101);
  const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket!;
  socket.accept();
  const frames: Array<string | ArrayBuffer> = [];
  socket.addEventListener('message', (e: MessageEvent) => frames.push(e.data as string | ArrayBuffer));
  return { socket, frames };
}

/** Connect one node and enqueue a task that is immediately delivered to it. */
async function connectAndAssign(nodeId: string): Promise<{ task: TaskRecord; node: SwarmSocket }> {
  const node = await connectNode(nodeId, 'capabilities=ai-inference');
  const task = makeTask();
  await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
  await new Promise(r => setTimeout(r, 30));
  return { task, node };
}

function jsonFrames(node: SwarmSocket): any[] {
  return node.frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));
}

function swarmChainFor(init: any): SwarmChainNode[] {
  const members = init.members as Array<{ nodeId: string }>;
  const half = 6;
  return members.map((m, i) => ({
    nodeId: m.nodeId,
    role: i === 0 ? 'host' : 'worker',
    slice:
      i === 0
        ? { start: 0, end: half, hasEmbed: true, hasHead: true }
        : { start: half, end: 8, hasEmbed: false, hasHead: false },
  }));
}

describe('Coordinator swarm sessions', () => {
  async function setup() {
    stub = newStub();
    const n1 = await connectNode('n1', 'capabilities=swarm-inference&webgpu=true&wasm=4000000000');
    const n2 = await connectNode('n2', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000');
    const n3 = await connectNode('n3', 'capabilities=swarm-inference');

    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3-1.7b', prompt: 'hi' } });
    await seedPending([task], ['n1', 'n2', 'n3']);
    await runAssign();
    return { task, n1, n2, n3 };
  }

  it('reserves WebGPU nodes for the chain and sends swarm-init to the strongest (host)', async () => {
    const { task, n1, n2, n3 } = await setup();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    // n2 has the most capacity, so it becomes the host.
    expect(stored.assignedNodeId).toBe('n2');

    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init');
    expect(init).toBeTruthy();
    expect(init.taskId).toBe(task.id);
    expect(typeof init.attemptId).toBe('string');
    expect(init.members.map((m: any) => m.nodeId)).toEqual(['n2', 'n1']);
    // The non-WebGPU node is not a member, and only the host is asked to plan.
    expect(jsonFrames(n1).some((f) => f.type === 'swarm-init')).toBe(false);
    expect(jsonFrames(n3).some((f) => f.type === 'swarm-init')).toBe(false);
  });

  it('leaves a swarm task pending when only one candidate node is available', async () => {
    stub = newStub();
    await connectNode('solo', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000');
    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3-1.7b', prompt: 'hi' } });
    await seedPending([task], ['solo']);

    await runAssign();

    // A single node would own the whole model and see the whole prompt, so the
    // coordinator refuses to start a "swarm" of one.
    const stored = await getTask(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();
  });

  it('hands out slices from the host plan and starts the host when all are ready', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    const chain = swarmChainFor(init);

    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain }));
    await new Promise((r) => setTimeout(r, 30));

    const hostSlice = jsonFrames(n2).find((f) => f.type === 'swarm-slice');
    const workerSlice = jsonFrames(n1).find((f) => f.type === 'swarm-slice');
    expect(hostSlice).toMatchObject({ index: 0, chainLength: 2, role: 'host', slice: { start: 0, end: 6 } });
    expect(workerSlice).toMatchObject({ index: 1, chainLength: 2, role: 'worker', slice: { start: 6, end: 8 } });

    // The plan is persisted on the task for frame routing.
    const stored = await getTask(task.id);
    expect(stored.swarmSession?.layers).toBe(8);
    expect(stored.swarmSession?.chain.map((c) => c.nodeId)).toEqual(['n2', 'n1']);

    expect(jsonFrames(n2).some((f) => f.type === 'swarm-start')).toBe(false);
    n1.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    await new Promise((r) => setTimeout(r, 20));
    expect(jsonFrames(n2).some((f) => f.type === 'swarm-start')).toBe(false);
    n2.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    await new Promise((r) => setTimeout(r, 20));
    expect(jsonFrames(n2).some((f) => f.type === 'swarm-start')).toBe(true);
  });

  it('ignores a non-host plan without allowing a member to fail the task', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;

    n1.socket.send(JSON.stringify({
      type: 'swarm-plan', sessionId: init.sessionId,
      chain: [{ nodeId: 'n1', role: 'host', slice: { start: 0, end: 1e9, hasEmbed: true, hasHead: true } }],
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect((await getTask(task.id)).status).toBe('processing');
    expect(jsonFrames(n2).some((f) => f.type === 'swarm-error')).toBe(false);

    // The authenticated host can still submit the valid plan after the attack.
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));
    expect((await getTask(task.id)).swarmSession?.chain.map((entry) => entry.nodeId)).toEqual(['n2', 'n1']);
  });

  it('rejects a plan whose slice exceeds the layer bounds instead of crashing a node', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;

    // A malicious host assigning a real volunteer the whole model (and more):
    // `end: 1e9` would make the node expand the model into GPU memory and OOM.
    const hostile: SwarmChainNode[] = [
      { nodeId: 'n2', role: 'host', slice: { start: 0, end: 6, hasEmbed: true, hasHead: true } },
      { nodeId: 'n1', role: 'worker', slice: { start: 6, end: 1e9, hasEmbed: false, hasHead: false } },
    ];
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: hostile }));
    await new Promise((r) => setTimeout(r, 50));

    const errors = jsonFrames(n2).filter((f) => f.type === 'swarm-error');
    expect(errors.length).toBeGreaterThan(0);
    expect(jsonFrames(n1).some((f) => f.type === 'swarm-slice')).toBe(false);

    // The plan is derived from the model metadata, so it is failed for good
    // rather than retried into the same crash.
    const stored = await getTask(task.id);
    expect(stored.status).toBe('failed');
  });

  it('relays a binary hidden frame to the next hop', async () => {
    const { n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // Host (n2, index 0) sends a hidden frame; it should reach n1 (index 1)
    // byte-for-byte (the coordinator never rewrites a frame).
    const envelope = encodeSwarmEnvelope(init.sessionId, new ArrayBuffer(16));
    n2.socket.send(envelope);
    await new Promise((r) => setTimeout(r, 30));
    expect(n1.frames.some((f) => typeof f !== 'string' && (f as ArrayBuffer).byteLength === envelope.byteLength)).toBe(
      true,
    );
  });

  it('hands every member distinct per-hop frame keys', async () => {
    const { n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // n2 is the host (index 0), n1 the worker (index 1). Each member gets the
    // key for the edge it sends on and the key for the edge it receives on, so
    // one member cannot sign a frame as another hop.
    const hostSlice = jsonFrames(n2).find((f) => f.type === 'swarm-slice')!;
    const workerSlice = jsonFrames(n1).find((f) => f.type === 'swarm-slice')!;
    expect(typeof hostSlice.outboundKey).toBe('string');
    expect(typeof workerSlice.outboundKey).toBe('string');
    expect(hostSlice.outboundKey).not.toBe(workerSlice.outboundKey);
    expect(workerSlice.inboundKey).toBe(hostSlice.outboundKey);
    expect(hostSlice.inboundKey).toBe(workerSlice.outboundKey);
    // 32 random bytes, base64url without padding.
    expect(hostSlice.outboundKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts only the host result and releases every member', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // A worker's result is ignored, even with the session id and attempt id.
    n1.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, sessionId: init.sessionId, payload: { output: 'wrong' }, attemptId: init.attemptId,
    }));
    await new Promise((r) => setTimeout(r, 20));
    let stored = await getTask(task.id);
    expect(stored.status).toBe('processing');

    // The host completes the task.
    n2.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, sessionId: init.sessionId, payload: { output: 'ok', tokens: [1] }, attemptId: init.attemptId,
    }));
    await new Promise((r) => setTimeout(r, 20));
    stored = await getTask(task.id);
    expect(stored.status).toBe('done');
    expect(stored.result).toEqual({ output: 'ok', tokens: [1] });

    await withStorage(async (storage) => {
      const a = await storage.get<any>('node:n1');
      const b = await storage.get<any>('node:n2');
      expect(a.status).toBe('idle');
      expect(b.status).toBe('idle');
      expect(await storage.get(`swarm:${task.id}`)).toBeUndefined();
    });
  });

  it('does not let a member fail another member\'s task', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // The worker reports a failure. It must not settle the task; the host owns
    // the session and is told instead.
    n1.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: init.sessionId, error: 'member blew up' }));
    await new Promise((r) => setTimeout(r, 50));

    let stored = await getTask(task.id);
    expect(stored.status).toBe('processing');
    expect(stored.retryCount).toBe(0);
    const relayed = jsonFrames(n2).filter((f) => f.type === 'swarm-error');
    expect(relayed.length).toBeGreaterThan(0);
    expect(relayed[0]).toMatchObject({ taskId: task.id, sessionId: init.sessionId, error: 'member blew up' });

    // The host failing the session settles it: every member is stopped and the
    // task burns one retry instead of hanging until the timeout.
    n2.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: init.sessionId, error: 'host gave up', attemptId: init.attemptId }));
    await new Promise((r) => setTimeout(r, 50));

    for (const node of [n1, n2]) {
      const aborts = jsonFrames(node).filter((f) => f.type === 'abort');
      expect(aborts.length).toBeGreaterThan(0);
      expect(aborts[0]).toMatchObject({ taskId: task.id, error: 'host gave up' });
    }

    stored = await getTask(task.id);
    expect(stored.retryCount).toBe(1);
    expect(['pending', 'processing']).toContain(stored.status);
  });

  it('ignores swarm-token and swarm-done from a member', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    const subscriber = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const subSocket = (subscriber as unknown as { webSocket?: WebSocket }).webSocket!;
    subSocket.accept();
    const subFrames: string[] = [];
    subSocket.addEventListener('message', (e: MessageEvent) => subFrames.push(String(e.data)));
    await new Promise((r) => setTimeout(r, 20));

    // A member must not be able to inject tokens into the requester's stream.
    n1.socket.send(JSON.stringify({ type: 'swarm-token', sessionId: init.sessionId, token: 'injected', attemptId: init.attemptId }));
    n1.socket.send(JSON.stringify({ type: 'swarm-done', sessionId: init.sessionId, attemptId: init.attemptId }));
    await new Promise((r) => setTimeout(r, 30));
    expect(subFrames.some((f) => f.includes('injected'))).toBe(false);

    // The host may stream tokens (it owns the generation loop).
    n2.socket.send(JSON.stringify({ type: 'swarm-token', sessionId: init.sessionId, token: 'hello', attemptId: init.attemptId }));
    await new Promise((r) => setTimeout(r, 30));
    expect(subFrames.some((f) => f.includes('hello'))).toBe(true);
  });

  it('rejects an oversized or over-rate progress token', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;

    const subscriber = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const subSocket = (subscriber as unknown as { webSocket?: WebSocket }).webSocket!;
    subSocket.accept();
    const subFrames: string[] = [];
    subSocket.addEventListener('message', (e: MessageEvent) => subFrames.push(String(e.data)));
    await new Promise(r => setTimeout(r, 20));

    node.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: 'x'.repeat(5000), attemptId }));
    await new Promise(r => setTimeout(r, 20));
    expect(subFrames.some((f) => f.includes('xxxx'))).toBe(false);

    node.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: 'ok', attemptId }));
    await new Promise(r => setTimeout(r, 20));
    expect(subFrames.some((f) => f.includes('ok'))).toBe(true);

    // The per-task rate limit drops the flood instead of forwarding it.
    for (let i = 0; i < 80; i++) {
      node.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: 'flood', attemptId }));
    }
    await new Promise(r => setTimeout(r, 50));
    const floods = subFrames.filter((f) => f.includes('flood')).length;
    expect(floods).toBeLessThan(80);
  });

  it('ignores progress from a node that does not own the task', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const other = await connectNode('node-2', 'capabilities=ai-inference');

    const subscriber = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const subSocket = (subscriber as unknown as { webSocket?: WebSocket }).webSocket!;
    subSocket.accept();
    const subFrames: string[] = [];
    subSocket.addEventListener('message', (e: MessageEvent) => subFrames.push(String(e.data)));
    await new Promise(r => setTimeout(r, 20));

    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;
    other.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: 'from-other', attemptId }));
    await new Promise(r => setTimeout(r, 20));
    expect(subFrames.some((f) => f.includes('from-other'))).toBe(false);
  });

  it.each(['n1', 'n2'])('restarts the whole swarm when %s reconnects', async (nodeId) => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find(f => f.type === 'swarm-init');
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise(r => setTimeout(r, 20));
    const replacement = await connectNode(nodeId,
      `capabilities=swarm-inference&webgpu=true&wasm=${nodeId === 'n2' ? 8000000000 : 4000000000}`);
    await new Promise(r => setTimeout(r, 30));
    const host = nodeId === 'n2' ? replacement : n2;
    const worker = nodeId === 'n1' ? replacement : n1;
    const inits = jsonFrames(host).filter(f => f.type === 'swarm-init');
    const next = inits[inits.length - 1];
    expect(next.sessionId).not.toBe(init.sessionId);
    for (const member of [host, worker]) {
      expect(jsonFrames(member)).toContainEqual(expect.objectContaining({
        type: 'abort', taskId: task.id, sessionId: init.sessionId,
      }));
      expect(jsonFrames(member).some(f => f.type === 'task')).toBe(false);
    }
    await withStorage(async storage => {
      for (const id of ['n1', 'n2']) {
        expect(await storage.get(`node:${id}`)).toMatchObject({ status: 'busy', currentTaskId: task.id });
      }
    });
    expect(await getTask(task.id)).toMatchObject({
      status: 'processing', retryCount: 1,
    });
  });

  it('ignores stale attempts and errors from non-members', async () => {
    const { task, n1, n2, n3 } = await setup();
    const init = jsonFrames(n2).find(f => f.type === 'swarm-init');
    const chain = swarmChainFor(init);
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: 'old-session', chain }));
    await new Promise(r => setTimeout(r, 20));
    expect(jsonFrames(n1).some(f => f.type === 'swarm-slice')).toBe(false);
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain }));
    await new Promise(r => setTimeout(r, 20));
    n1.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: 'old-session' }));
    n2.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    n2.socket.send(JSON.stringify({ type: 'result', taskId: task.id, sessionId: 'old-session', payload: {}, attemptId: init.attemptId }));
    n1.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: 'old-session', error: 'old' }));
    n3.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: init.sessionId, error: 'unrelated' }));
    n2.socket.send(encodeSwarmEnvelope('old-session', new ArrayBuffer(16)));
    await new Promise(r => setTimeout(r, 30));
    expect(jsonFrames(n2).some(f => f.type === 'swarm-start')).toBe(false);
    expect(n1.frames.some(f => typeof f !== 'string')).toBe(false);
    expect(await getTask(task.id)).toMatchObject({
      status: 'processing', retryCount: 0,
    });
    n1.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    await new Promise(r => setTimeout(r, 20));
    expect(jsonFrames(n2).some(f => f.type === 'swarm-start')).toBe(true);
  });
});