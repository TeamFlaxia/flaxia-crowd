import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import type { NodeResourceReport, NodeModelCacheSnapshot, TaskRecord } from '@flaxia/sdk';
import { MAX_RESOURCE_CAPACITY_BYTES, THEIA_DLLM_MODEL_ID, verifyCrowdWebhook } from '@flaxia/sdk';
import { ALARM_INTERVAL_MS, CANCELLED_BY_CALLER, MAX_PENDING_TASKS, MAX_PENDING_TTL_MS, MAX_RETRIES, MAX_RESULT_BYTES, MAX_SUBSCRIBERS_PER_TASK, THEIA_MAX_PENDING_TTL_MS, pendingTtlMs, resolveWarmModelId, resolveWarmTarget, taskTimeoutMs, validateResultPayload } from '../Coordinator';
import { parseWarmModels } from '../../crowd/index';
import { TEST_WEBHOOK_SIGNING_SECRET } from './testSecrets';

interface NodeRecord {
  id: string;
  status: "idle" | "busy";
  capabilities: string[];
  expertCapabilities?: string[];
  cpuLoad: number;
  connectedAt: number;
  lastPongAt: number;
  fileSources?: boolean;
  currentTaskId?: string;
  siteId?: string;
  assignedCount?: number;
  awaitingPong?: boolean;
  warmModels?: Array<{ modelId: string; startLayer: number; endLayer: number; downloadedAt: number }>;
  resources?: NodeResourceReport;
  modelCache?: NodeModelCacheSnapshot;
  reservation?: { taskId: string; generation: string; expiresAt: number };
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

function freshResourceReport(now = Date.now()): NodeResourceReport {
  const metric = (value: number | string | null, unit: string, source: string, ttl: number) => ({
    value, unit, source, sampledAt: now, expiresAt: now + ttl, sampleCount: value === null ? 0 : 1,
  });
  return {
    version: 1,
    sampledAt: now,
    expiresAt: now + 90_000,
    cpuLoad: metric(0.25, 'ratio', 'estimated', 90_000) as NodeResourceReport['cpuLoad'],
    wasmMemoryLowerBound: metric(2 * 1024 ** 3, 'bytes', 'measured', 24 * 60 * 60 * 1000) as NodeResourceReport['wasmMemoryLowerBound'],
    deviceMemory: metric(null, 'GiB', 'unknown', 24 * 60 * 60 * 1000) as NodeResourceReport['deviceMemory'],
    gpu: {
      status: 'available',
      sampledAt: now,
      expiresAt: now + 10 * 60 * 1000,
      architecture: metric('test-gpu', 'text', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['architecture'],
      maxStorageBufferBindingSize: metric(128 * 1024 ** 2, 'bytes', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['maxStorageBufferBindingSize'],
      computeCompletionMs: metric(2, 'ms', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['computeCompletionMs'],
      memoryBytes: metric(null, 'bytes', 'unknown', 10 * 60 * 1000) as NodeResourceReport['gpu']['memoryBytes'],
    },
  };
}

function readyEntry(modelId: string, adapterId?: string): NodeModelCacheSnapshot['entries'][number] {
  return {
    modelId,
    revision: adapterId ? 'adapter' : 'base',
    dtype: 'q4_0',
    backend: 'wasm',
    state: 'ready',
    referenceCount: 1,
    ...(adapterId ? { adapterId } : {}),
  };
}

function freshCache(now: number, ...entries: NodeModelCacheSnapshot['entries']): NodeModelCacheSnapshot {
  return { version: 1, sampledAt: now, expiresAt: now + 60_000, entries };
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
  it('starts and reschedules idle node heartbeats before any task is submitted', async () => {
    stub = newStub();
    expect(await withStorage((storage) => storage.getAlarm())).toBeNull();
    const connectedAt = Date.now();
    const node = await connectNode('native-idle', '');
    const alarm = await withStorage((storage) => storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(connectedAt);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + ALARM_INTERVAL_MS);

    await runAlarm();
    await vi.waitFor(() => expect(jsonFrames(node)).toContainEqual({ type: 'ping' }));
    const nextAlarm = await withStorage((storage) => storage.getAlarm());
    expect(nextAlarm).not.toBeNull();
    expect(nextAlarm!).toBeLessThanOrEqual(Date.now() + ALARM_INTERVAL_MS);
    expect(jsonFrames(node).some((frame) => frame.type === 'task')).toBe(false);
    node.socket.close();
  });

  it('brings a distant task alarm forward for a newly connected node heartbeat', async () => {
    stub = newStub();
    await withStorage((storage) => storage.setAlarm(Date.now() + 10 * ALARM_INTERVAL_MS));
    const node = await connectNode('native-distant-alarm', '');
    const alarm = await withStorage((storage) => storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(Date.now() + ALARM_INTERVAL_MS);
    node.socket.close();
  });

  it('preserves an earlier task alarm when a node connects', async () => {
    stub = newStub();
    const earlierAlarm = Date.now() + 5_000;
    await withStorage((storage) => storage.setAlarm(earlierAlarm));
    const node = await connectNode('native-earlier-alarm', '');
    expect(await withStorage((storage) => storage.getAlarm())).toBe(earlierAlarm);
    node.socket.close();
  });

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

  it('routes file-source container tasks only to nodes that advertised support', async () => {
    stub = newStub();
    const legacyNode = await connectNode('container-legacy', 'capabilities=container');
    const capableNode = await connectNode('container-files', 'capabilities=container&fileSources=true');
    const task = makeTask({
      workload: 'container',
      payload: {
        image: 'https://scanner.example/clamav.wasm',
        command: ['clamscan', 'input.jpg'],
        fileSources: {
          'input.jpg': {
            url: 'https://flaxia.app/api/crowd/scan-file',
            token: `${'a'.repeat(32)}.${'b'.repeat(64)}`,
            size: 4,
            sha256: 'a'.repeat(64),
          },
        },
      },
    });
    await seedPending([task], ['container-legacy', 'container-files']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const assigned = await getTask(task.id);
    expect(assigned.assignedNodeId).toBe('container-files');
    expect(jsonFrames(capableNode).some((frame) => frame.type === 'task')).toBe(true);
    expect(jsonFrames(legacyNode).some((frame) => frame.type === 'task')).toBe(false);
  });

  it('keeps legacy inline container tasks routable to older nodes', async () => {
    stub = newStub();
    const legacyNode = await connectNode('container-legacy-inline', 'capabilities=container');
    const task = makeTask({
      workload: 'container',
      payload: {
        image: 'https://scanner.example/clamav.wasm',
        command: ['clamscan', 'input.jpg'],
        files: { 'input.jpg': 'AQIDBA==' },
      },
    });
    await seedPending([task], ['container-legacy-inline']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await getTask(task.id)).assignedNodeId).toBe('container-legacy-inline');
    expect(jsonFrames(legacyNode).some((frame) => frame.type === 'task')).toBe(true);
  });

  it('routes a theia expert task only to nodes that registered that expert', async () => {
    stub = newStub();
    const base = await connectNode('theia-base', 'capabilities=theia-inference');
    const other = await connectNode('theia-other-expert', 'capabilities=theia-inference&expertCapabilities=theia-expert-writer');
    const expert = await connectNode(
      'theia-coder',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder,theia-expert-writer',
    );
    const task = makeTask({
      workload: 'theia-inference',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        model: THEIA_DLLM_MODEL_ID,
        expert: 'coder',
      },
    });
    await seedPending([task], ['theia-base', 'theia-other-expert', 'theia-coder']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await getTask(task.id)).assignedNodeId).toBe('theia-coder');
    expect(jsonFrames(expert).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
    expect(jsonFrames(base).some((frame) => frame.type === 'task')).toBe(false);
    expect(jsonFrames(other).some((frame) => frame.type === 'task')).toBe(false);
  });

  it('keeps expert-less theia tasks routable to an ordinary node', async () => {
    stub = newStub();
    const base = await connectNode('theia-plain', 'capabilities=theia-inference');
    const task = makeTask({
      workload: 'theia-inference',
      payload: { messages: [{ role: 'user', content: 'hi' }], model: THEIA_DLLM_MODEL_ID },
    });
    await seedPending([task], ['theia-plain']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect((await getTask(task.id)).assignedNodeId).toBe('theia-plain');
    expect(jsonFrames(base).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
  });

  it('matches a resident LoRA adapter by adapter id when placing an expert task', async () => {
    stub = newStub();
    const coder = await connectNode(
      'theia-warm-coder',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const writer = await connectNode(
      'theia-warm-writer',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder,theia-expert-writer',
    );
    const now = Date.now();
    const cacheFor = (adapterId: string): NodeModelCacheSnapshot => ({
      version: 1,
      sampledAt: now,
      expiresAt: now + 60_000,
      entries: [{
        modelId: THEIA_DLLM_MODEL_ID,
        revision: 'adapter',
        dtype: 'q4_0',
        backend: 'wasm',
        state: 'ready',
        referenceCount: 1,
        adapterId,
      }],
    });
    await withStorage(async (storage) => {
      await storage.put('node:theia-warm-coder', { ...(await storage.get<NodeRecord>('node:theia-warm-coder'))!, modelCache: cacheFor('coder') });
      await storage.put('node:theia-warm-writer', { ...(await storage.get<NodeRecord>('node:theia-warm-writer'))!, modelCache: cacheFor('writer') });
    });

    const task = makeTask({
      workload: 'theia-inference',
      payload: { messages: [{ role: 'user', content: 'hi' }], model: 'a-public-alias', expert: 'coder' },
    });
    await seedPending([task], ['theia-warm-coder', 'theia-warm-writer']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('theia-warm-coder');
    expect(scheduled.placementReason).toBe('warm-model');
    expect(jsonFrames(coder).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
  });

  it('prefers a base-warm node over a cold node for an expert task', async () => {
    stub = newStub();
    const baseWarm = await connectNode(
      'theia-base-warm',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const cold = await connectNode(
      'theia-expert-cold',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const now = Date.now();
    await withStorage(async (storage) => {
      const record = (await storage.get<NodeRecord>('node:theia-base-warm'))!;
      record.modelCache = freshCache(now, readyEntry(THEIA_DLLM_MODEL_ID));
      await storage.put('node:theia-base-warm', record);
    });

    const task = makeTask({
      workload: 'theia-inference',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        model: THEIA_DLLM_MODEL_ID,
        expert: 'coder',
      },
    });
    await seedPending([task], ['theia-base-warm', 'theia-expert-cold']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('theia-base-warm');
    expect(scheduled.placementReason).toBe('warm-base-model');
    expect(jsonFrames(baseWarm).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
    expect(jsonFrames(cold).some((frame) => frame.type === 'task')).toBe(false);
  });

  it('prefers a fully warm expert node over a base-only warm node', async () => {
    stub = newStub();
    const baseWarm = await connectNode(
      'theia-base-only',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const fullyWarm = await connectNode(
      'theia-adapter-ready',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const now = Date.now();
    await withStorage(async (storage) => {
      const base = (await storage.get<NodeRecord>('node:theia-base-only'))!;
      base.modelCache = freshCache(now, readyEntry(THEIA_DLLM_MODEL_ID));
      await storage.put('node:theia-base-only', base);
      const adapter = (await storage.get<NodeRecord>('node:theia-adapter-ready'))!;
      adapter.modelCache = freshCache(now, readyEntry(THEIA_DLLM_MODEL_ID, 'coder'));
      await storage.put('node:theia-adapter-ready', adapter);
    });

    const task = makeTask({
      workload: 'theia-inference',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
        model: THEIA_DLLM_MODEL_ID,
        expert: 'coder',
      },
    });
    await seedPending([task], ['theia-base-only', 'theia-adapter-ready']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('theia-adapter-ready');
    expect(scheduled.placementReason).toBe('warm-model');
    expect(jsonFrames(fullyWarm).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
    expect(jsonFrames(baseWarm).some((frame) => frame.type === 'task')).toBe(false);
  });

  it('does not treat a resident LoRA adapter as warm for an expert-less task', async () => {
    stub = newStub();
    const base = await connectNode('theia-base-cache', 'capabilities=theia-inference');
    const adapter = await connectNode(
      'theia-adapter-cache',
      'capabilities=theia-inference&expertCapabilities=theia-expert-coder',
    );
    const now = Date.now();
    await withStorage(async (storage) => {
      const shared = { version: 1, sampledAt: now, expiresAt: now + 60_000 } as const;
      await storage.put('node:theia-base-cache', {
        ...(await storage.get<NodeRecord>('node:theia-base-cache'))!,
        modelCache: { ...shared, entries: [{
          modelId: THEIA_DLLM_MODEL_ID,
          revision: 'base',
          dtype: 'q4_0',
          backend: 'wasm',
          state: 'ready',
          referenceCount: 1,
        }] },
      });
      await storage.put('node:theia-adapter-cache', {
        ...(await storage.get<NodeRecord>('node:theia-adapter-cache'))!,
        modelCache: { ...shared, entries: [{
          modelId: THEIA_DLLM_MODEL_ID,
          revision: 'adapter',
          dtype: 'q4_0',
          backend: 'wasm',
          state: 'ready',
          referenceCount: 1,
          adapterId: 'coder',
        }] },
      });
    });

    const task = makeTask({
      workload: 'theia-inference',
      payload: { messages: [{ role: 'user', content: 'hi' }], model: THEIA_DLLM_MODEL_ID },
    });
    await seedPending([task], ['theia-base-cache', 'theia-adapter-cache']);
    await runAssign();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('theia-base-cache');
    expect(scheduled.placementReason).toBe('warm-model');
    expect(jsonFrames(base).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
    expect(jsonFrames(adapter).some((frame) => frame.type === 'task')).toBe(false);
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

  it('cancels a processing task permanently and aborts its assigned node', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-cancel');

    const resp = await stub.fetch(`http://internal/cancel/${TENANT}/${task.id}`, { method: 'POST' });
    expect(resp.status).toBe(200);
    const cancelled = await resp.json() as TaskRecord;
    expect(cancelled).toMatchObject({ status: 'failed', error: CANCELLED_BY_CALLER, retryCount: 0 });

    const aborts = jsonFrames(node).filter(f => f.type === 'abort');
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatchObject({ taskId: task.id, error: CANCELLED_BY_CALLER });

    // Terminal tasks are returned as-is, and another tenant cannot cancel it.
    const again = await stub.fetch(`http://internal/cancel/${TENANT}/${task.id}`, { method: 'POST' });
    expect(await again.json()).toMatchObject({ status: 'failed', error: CANCELLED_BY_CALLER });
    const foreign = await stub.fetch(`http://internal/cancel/${OTHER_TENANT}/${task.id}`, { method: 'POST' });
    expect(foreign.status).toBe(404);
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

  it('restores fresh snapshots on reconnect and waits for a pong before assigning', async () => {
    stub = newStub();
    const first = await connectNode('node-reconnect', 'capabilities=ai-inference');
    const now = Date.now();
    const resources = freshResourceReport(now);
    const modelCache = freshCache(now, readyEntry('test-model'));
    first.socket.send(JSON.stringify({ type: 'pong', cpuLoad: 0.1, resources, modelCache }));
    await vi.waitFor(async () => {
      await withStorage(async (storage) => {
        const record = await storage.get<NodeRecord>('node:node-reconnect');
        expect(record?.modelCache).toEqual(modelCache);
        expect(record?.resources).toEqual(resources);
      });
    });

    const replacement = await connectNode('node-reconnect', 'capabilities=ai-inference');
    await withStorage(async (storage) => {
      // The fresh snapshots survive the new socket's rebuilt NodeRecord, and
      // the node waits for a heartbeat before it may receive new work.
      expect(await storage.get<NodeRecord>('node:node-reconnect')).toMatchObject({
        modelCache, resources, awaitingPong: true,
      });
    });

    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // No assignment until the reconnected node answers a heartbeat.
    expect((await getTask(task.id)).status).toBe('pending');

    replacement.socket.send(JSON.stringify({ type: 'pong', cpuLoad: 0.1 }));
    await vi.waitFor(async () => expect((await getTask(task.id)).status).toBe('processing'));
    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('node-reconnect');
    await withStorage(async (storage) => {
      expect((await storage.get<NodeRecord>('node:node-reconnect'))?.awaitingPong).toBe(false);
      expect((await storage.get<NodeRecord>('node:node-reconnect'))?.modelCache).toEqual(modelCache);
    });
  });

  it('ranks a reconnected node with a restored model cache above a cold node', async () => {
    stub = newStub();
    const first = await connectNode('node-reconnect-warm', 'capabilities=ai-inference');
    const now = Date.now();
    const modelCache = freshCache(now, readyEntry('test-model'));
    first.socket.send(JSON.stringify({ type: 'pong', modelCache }));
    await vi.waitFor(async () => {
      await withStorage(async (storage) => {
        expect((await storage.get<NodeRecord>('node:node-reconnect-warm'))?.modelCache).toEqual(modelCache);
      });
    });

    const replacement = await connectNode('node-reconnect-warm', 'capabilities=ai-inference');
    await connectNode('node-reconnect-cold', 'capabilities=ai-inference');
    replacement.socket.send(JSON.stringify({ type: 'pong' }));
    await vi.waitFor(async () => {
      await withStorage(async (storage) => {
        expect((await storage.get<NodeRecord>('node:node-reconnect-warm'))?.awaitingPong).toBe(false);
      });
    });

    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('node-reconnect-warm');
    expect(scheduled.placementReason).toBe('warm-model');
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

  it('stores advertised warm-model capabilities', async () => {
    stub = newStub();
    const warm = JSON.stringify([{ modelId: 'qwen3-1.7b', layers: [0, 13] }]);

    const resp = await stub.fetch(
      `http://internal/ws?nodeId=node-cap&capabilities=ai-inference&warmModels=${encodeURIComponent(warm)}&site=example.com`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } },
    );
    expect(resp.status).toBe(101);

    interface StoredNode {
      warmModels?: unknown;
      siteId?: string;
    }

    await withStorage(async (storage) => {
      const node = await storage.get<StoredNode>('node:node-cap');
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

  it('rate limits the register-rate endpoint per IP in storage', async () => {
    stub = newStub();
    let got429 = false;
    for (let i = 0; i < 110; i++) {
      const resp = await stub.fetch('http://internal/register-rate', {
        headers: { 'CF-Connecting-IP': '203.0.113.9' },
      });
      if (resp.status === 429) {
        got429 = true;
        break;
      }
      expect(resp.status).toBe(200);
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

  it('uses the Theia pending cap only for theia-inference, never past the task timeout', () => {
    expect(taskTimeoutMs('theia-inference')).toBe(THEIA_MAX_PENDING_TTL_MS);
    expect(pendingTtlMs('theia-inference')).toBe(THEIA_MAX_PENDING_TTL_MS);
    expect(pendingTtlMs('theia-inference', THEIA_MAX_PENDING_TTL_MS)).toBe(THEIA_MAX_PENDING_TTL_MS);
    expect(pendingTtlMs('theia-inference', 120_000)).toBe(120_000);
    expect(pendingTtlMs('ai-inference', THEIA_MAX_PENDING_TTL_MS)).toBe(MAX_PENDING_TTL_MS);
  });

  it('schedules the sweep at the Theia cap instead of the generic five minutes', async () => {
    stub = newStub();
    const task = makeTask({
      workload: 'theia-inference',
      timeoutMs: THEIA_MAX_PENDING_TTL_MS,
    });
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });

    const alarm = await withStorage((storage) => storage.getAlarm());
    expect(alarm).toBeTruthy();
    expect(alarm!).toBeGreaterThan(Date.now() + MAX_PENDING_TTL_MS + 1000);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + THEIA_MAX_PENDING_TTL_MS + 1000);
  });

  it('keeps a Theia task pending past the generic TTL while waiting for an expert node', async () => {
    stub = newStub();
    const task = makeTask({
      workload: 'theia-inference',
      createdAt: Date.now() - MAX_PENDING_TTL_MS - 1000,
      timeoutMs: THEIA_MAX_PENDING_TTL_MS,
    });
    await seedPending([task], []);

    await runAlarm();

    expect((await getTask(task.id)).status).toBe('pending');
  });

  it('fails a Theia task permanently, with a clear reason, after its full pending deadline', async () => {
    stub = newStub();
    const task = makeTask({
      workload: 'theia-inference',
      createdAt: Date.now() - THEIA_MAX_PENDING_TTL_MS - 1000,
      timeoutMs: THEIA_MAX_PENDING_TTL_MS,
    });
    await seedPending([task], []);

    await runAlarm();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatch(/theia-inference.*30-minute queue deadline/);
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

  it('does not trust a self-asserted site id to satisfy an allow-list', async () => {
    stub = newStub();
    // `/nodes/register` signs client-provided siteId values, but that does not
    // prove either node controls these domains.
    await connectNode('node-other', 'capabilities=ai-inference&site=other.example');
    await connectNode('node-claiming-trusted', 'capabilities=ai-inference&site=trusted.example');

    const task = makeTask({
      payload: { task: 'text-generation', model: 'm', input: 'hi', allowedSites: ['trusted.example'] } as TaskRecord['payload'],
      allowedSites: ['trusted.example'],
    });
    await seedPending([task], ['node-other', 'node-claiming-trusted']);

    await runAssign();

    const stored = await getTask(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();
  });

  it('leaves a site-restricted task pending when no verified site proof exists', async () => {
    stub = newStub();
    await connectNode('node-other', 'capabilities=ai-inference&site=trusted.example');

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

  it('stores only fresh bounded resource and executable model snapshots from authenticated heartbeats', async () => {
    stub = newStub();
    const node = await connectNode('node-resource', 'capabilities=ai-inference');
    const now = Date.now();
    const metric = (value: number | string | null, unit: string, source: string, ttl: number) => ({
      value,
      unit,
      source,
      sampledAt: now,
      expiresAt: now + ttl,
      sampleCount: value === null ? 0 : 1,
    });
    const valid: NodeResourceReport = {
      version: 1,
      sampledAt: now,
      expiresAt: now + 90_000,
      cpuLoad: metric(0.25, 'ratio', 'estimated', 90_000) as NodeResourceReport['cpuLoad'],
      wasmMemoryLowerBound: metric(2 * 1024 ** 3, 'bytes', 'measured', 24 * 60 * 60 * 1000) as NodeResourceReport['wasmMemoryLowerBound'],
      deviceMemory: metric(null, 'GiB', 'unknown', 24 * 60 * 60 * 1000) as NodeResourceReport['deviceMemory'],
      gpu: {
        status: 'available',
        sampledAt: now,
        expiresAt: now + 10 * 60 * 1000,
        architecture: metric('test-gpu', 'text', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['architecture'],
        maxStorageBufferBindingSize: metric(128 * 1024 ** 2, 'bytes', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['maxStorageBufferBindingSize'],
        computeCompletionMs: metric(2, 'ms', 'measured', 10 * 60 * 1000) as NodeResourceReport['gpu']['computeCompletionMs'],
        memoryBytes: metric(null, 'bytes', 'unknown', 10 * 60 * 1000) as NodeResourceReport['gpu']['memoryBytes'],
      },
    };
    const modelCache: NodeModelCacheSnapshot = {
      version: 1,
      sampledAt: now,
      expiresAt: now + 60_000,
      entries: [{ modelId: 'qwen3-1.7b', revision: 'main', dtype: 'q4_0', backend: 'webgpu', layerRange: [0, 16], state: 'ready', referenceCount: 1 }],
    };
    node.socket.send(JSON.stringify({ type: 'pong', resources: valid, modelCache }));
    await new Promise(r => setTimeout(r, 30));
    await withStorage(async (storage) => {
      expect((await storage.get<NodeRecord>('node:node-resource'))!.resources?.gpu.computeCompletionMs.value).toBe(2);
      expect((await storage.get<NodeRecord>('node:node-resource'))!.modelCache?.entries[0].layerRange).toEqual([0, 16]);
    });

    const invalid = structuredClone(valid);
    invalid.wasmMemoryLowerBound.value = MAX_RESOURCE_CAPACITY_BYTES + 1;
    node.socket.send(JSON.stringify({ type: 'pong', resources: invalid, modelCache: { ...modelCache, entries: [{ ...modelCache.entries[0], referenceCount: -1 }] } }));
    await new Promise(r => setTimeout(r, 30));
    await withStorage(async (storage) => {
      // A malformed report must not replace the last valid measurement.
      expect((await storage.get<NodeRecord>('node:node-resource'))!.resources?.wasmMemoryLowerBound.value)
        .toBe(2 * 1024 ** 3);
      expect((await storage.get<NodeRecord>('node:node-resource'))!.modelCache?.entries[0].referenceCount).toBe(1);
    });
  });

  it('keeps a fresh saved model cache when a pong reports modelCache: null', async () => {
    stub = newStub();
    const node = await connectNode('node-null-pong', 'capabilities=ai-inference');
    const now = Date.now();
    const modelCache = freshCache(now, readyEntry('test-model'));
    node.socket.send(JSON.stringify({ type: 'pong', modelCache }));
    await vi.waitFor(async () => {
      await withStorage(async (storage) => {
        expect((await storage.get<NodeRecord>('node:node-null-pong'))?.modelCache).toEqual(modelCache);
      });
    });

    // `null` means "cannot send a snapshot now", not "I evicted everything":
    // a still-fresh saved snapshot must not be dropped.
    node.socket.send(JSON.stringify({ type: 'pong', modelCache: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await withStorage(async (storage) => {
      expect((await storage.get<NodeRecord>('node:node-null-pong'))?.modelCache).toEqual(modelCache);
    });

    // An expired snapshot is not worth keeping and is still discarded.
    await withStorage(async (storage) => {
      const record = (await storage.get<NodeRecord>('node:node-null-pong'))!;
      record.modelCache = { ...modelCache, sampledAt: now - 120_000, expiresAt: now - 60_000 };
      await storage.put('node:node-null-pong', record);
    });
    node.socket.send(JSON.stringify({ type: 'pong', modelCache: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await withStorage(async (storage) => {
      expect((await storage.get<NodeRecord>('node:node-null-pong'))?.modelCache).toBeUndefined();
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

  it('treats a NudeNet node as warm for the alias model the payload carries', async () => {
    stub = newStub();
    await connectNode('node-nude-cold', 'capabilities=nudenet');
    const warm = await connectNode('node-nude-warm', 'capabilities=nudenet');
    const now = Date.now();
    await withStorage(async (storage) => {
      const record = await storage.get<NodeRecord>('node:node-nude-warm');
      record!.modelCache = {
        version: 1,
        sampledAt: now,
        expiresAt: now + 60_000,
        entries: [
          {
            modelId: 'deepghs/nudenet_onnx',
            revision: 'main',
            dtype: 'q8_0',
            backend: 'wasm',
            state: 'ready',
            referenceCount: 1,
          },
        ],
      };
      await storage.put('node:node-nude-warm', record!);
    });

    // The public payload names the size alias, not the cache id.
    const task = makeTask({
      workload: 'nudenet',
      payload: { model: '320n', imageUrl: 'https://example.com/a.jpg' },
    });
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
    await new Promise(r => setTimeout(r, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('node-nude-warm');
    expect(scheduled.placementReason).toBe('warm-model');
    expect(jsonFrames(warm).some((frame) => frame.type === 'task' && frame.taskId === task.id)).toBe(true);
  });

  it('records why the warm model node won and exposes the current reservation generation', async () => {
    stub = newStub();
    await connectNode('node-cold', 'capabilities=ai-inference');
    const warm = await connectNode('node-warm', 'capabilities=ai-inference');
    const now = Date.now();
    await withStorage(async (storage) => {
      const record = await storage.get<NodeRecord>('node:node-warm');
      record!.modelCache = {
        version: 1,
        sampledAt: now,
        expiresAt: now + 60_000,
        entries: [{ modelId: 'test-model', revision: 'main', dtype: 'q4', backend: 'webgpu', state: 'ready', referenceCount: 1 }],
      };
      await storage.put('node:node-warm', record!);
    });

    const task = makeTask();
    await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
    await new Promise(r => setTimeout(r, 30));

    const scheduled = await getTask(task.id);
    expect(scheduled.assignedNodeId).toBe('node-warm');
    expect(scheduled.placementReason).toBe('warm-model');
    const attemptId = jsonFrames(warm).find((frame) => frame.type === 'task' && frame.taskId === task.id)!.attemptId;
    await withStorage(async (storage) => {
      expect(await storage.get<NodeRecord>('node:node-warm')).toMatchObject({
        status: 'busy',
        currentTaskId: task.id,
        reservation: { taskId: task.id, generation: attemptId },
      });
    });
  });

  it('finds eligible work behind more than one assignment pass of ineligible tasks', async () => {
    stub = newStub();
    await connectNode('available-ai', 'capabilities=ai-inference');
    const blocked = Array.from({ length: 33 }, () => makeTask({ workload: 'container', priority: 3 }));
    const eligible = makeTask({ priority: 0 });
    await seedPending([...blocked, eligible], ['available-ai']);
    await runAssign();
    expect(await getTask(eligible.id)).toMatchObject({ status: 'processing', assignedNodeId: 'available-ai' });
    expect(await getTask(blocked[0].id)).toMatchObject({ status: 'pending' });
  });

  it('ages a retry from its new pending interval', async () => {
    stub = newStub();
    await connectNode('retry-age-node', 'capabilities=ai-inference');
    const now = Date.now();
    const retry = makeTask({ priority: 0, createdAt: now - 240_000, queuedAt: now, retryCount: 1 });
    const interactive = makeTask({ priority: 3, createdAt: now });
    await seedPending([retry, interactive], ['retry-age-node']);
    await runAssign();
    expect(await getTask(interactive.id)).toMatchObject({ status: 'processing' });
    expect(await getTask(retry.id)).toMatchObject({ status: 'pending' });
  });

  it('ages old background work ahead of fresh interactive work and records queue wait', async () => {
    stub = newStub();
    await connectNode('fair-node', 'capabilities=ai-inference');
    const now = Date.now();
    const background = makeTask({ id: 'background', tenantId: TENANT, priority: 0, createdAt: now - 4 * 60_000 });
    const interactive = makeTask({ id: 'interactive', tenantId: OTHER_TENANT, priority: 3, createdAt: now });
    await seedPending([interactive, background], ['fair-node']);

    await runAssign();

    const assigned = await getTask(background.id);
    expect(assigned.status).toBe('processing');
    expect(assigned.queueWaitMs).toBeGreaterThanOrEqual(4 * 60_000);
    expect((await getTask(interactive.id, OTHER_TENANT)).status).toBe('pending');
  });

  it('ignores active idle-index leases and reuses a node when the lease expires', async () => {
    stub = newStub();
    await connectNode('node-leased', 'capabilities=ai-inference');
    await withStorage(async (storage) => {
      const record = await storage.get<NodeRecord>('node:node-leased');
      record!.reservation = { taskId: 'orphaned-task', generation: 'old-attempt', expiresAt: Date.now() + 60_000 };
      await storage.put('node:node-leased', record!);
    });

    const task = makeTask();
    await seedPending([task], ['node-leased']);
    await runAssign();
    expect((await getTask(task.id)).status).toBe('pending');

    await withStorage(async (storage) => {
      const record = await storage.get<NodeRecord>('node:node-leased');
      record!.reservation!.expiresAt = Date.now() - 1;
      await storage.put('node:node-leased', record!);
    });
    await runAssign();
    expect((await getTask(task.id)).assignedNodeId).toBe('node-leased');
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

  it('pauses a task at the subscriber high watermark and resumes after bounded acknowledgements', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-1');
    const attemptId = jsonFrames(node).find(f => f.type === 'task')!.attemptId as string;
    const response = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const subscriber = (response as unknown as { webSocket?: WebSocket }).webSocket!;
    subscriber.accept();
    const received: Array<Record<string, unknown>> = [];
    subscriber.addEventListener('message', (event: MessageEvent) => {
      try { received.push(JSON.parse(String(event.data))); } catch {}
    });
    subscriber.send(JSON.stringify({ type: 'flow-control', version: 1 }));
    await new Promise(resolve => setTimeout(resolve, 20));

    for (let i = 0; i < 16; i++) {
      node.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: `t${i}`, attemptId }));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(jsonFrames(node).some(frame => frame.type === 'task-flow' && frame.paused === true)).toBe(true);
    const sequence = received.filter(message => message.type === 'token')[7]?.sequence;
    expect(sequence).toBe(8);

    subscriber.send(JSON.stringify({ type: 'ack', sequence: 999 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(jsonFrames(node).some(frame => frame.type === 'task-flow' && frame.paused === false)).toBe(false);

    subscriber.send(JSON.stringify({ type: 'ack', sequence: 1 }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(jsonFrames(node).some(frame => frame.type === 'task-flow' && frame.paused === false)).toBe(false);

    subscriber.send(JSON.stringify({ type: 'ack', sequence: 8 }));
    await vi.waitFor(async () => {
      const snapshot = await runInDurableObject(stub, async (instance) => ({
        flow: await (instance as any).ctx.storage.get(`flow:${task.id}`),
        subscriber: (instance as any).ctx.getWebSockets(`client:${task.id}`)[0]?.deserializeAttachment(),
      }));
      expect(snapshot).toMatchObject({ flow: { paused: false }, subscriber: { ackSequence: 8 } });
    });
    await vi.waitFor(() => expect(jsonFrames(node).some(frame => frame.type === 'task-flow' && frame.paused === false)).toBe(true));
  });

  it('resets streamed output before a retry re-prefills the original prompt', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-restart-stream');
    const initialAttemptId = jsonFrames(node).find(frame => frame.type === 'task')!.attemptId as string;
    const response = await stub.fetch(`http://internal/subscribe?taskId=${task.id}&tenantId=${TENANT}`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    const subscriber = (response as unknown as { webSocket?: WebSocket }).webSocket!;
    subscriber.accept();
    const received: Array<Record<string, unknown>> = [];
    subscriber.addEventListener('message', (event: MessageEvent) => {
      try { received.push(JSON.parse(String(event.data))); } catch {}
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    node.socket.send(JSON.stringify({ type: 'progress', taskId: task.id, token: 'partial', attemptId: initialAttemptId }));
    await new Promise(resolve => setTimeout(resolve, 20));
    node.socket.send(JSON.stringify({ type: 'error', taskId: task.id, error: 'peer disconnected', attemptId: initialAttemptId }));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(received.some(message => message.type === 'token' && message.token === 'partial')).toBe(true);
    expect(received).toContainEqual({ type: 'reset', epoch: 1 });
    const retried = await getTask(task.id);
    expect(retried).toMatchObject({ status: 'processing', retryCount: 1, streamEpoch: 1 });
    const taskFrames = jsonFrames(node).filter(frame => frame.type === 'task');
    const nextAttemptId = taskFrames.length ? taskFrames[taskFrames.length - 1].attemptId : undefined;
    expect(nextAttemptId).toEqual(expect.any(String));
    expect(nextAttemptId).not.toBe(initialAttemptId);
  });

  it('fails a permanent node error immediately without retrying', async () => {
    stub = newStub();
    const { task, node } = await connectAndAssign('node-permanent');
    const attemptId = jsonFrames(node).find(frame => frame.type === 'task')!.attemptId as string;

    node.socket.send(JSON.stringify({
      type: 'error',
      taskId: task.id,
      error: 'theia-inference: invalid payload',
      attemptId,
      permanent: true,
    }));

    await vi.waitFor(async () => {
      const failed = await getTask(task.id);
      expect(failed.status).toBe('failed');
      expect(String(failed.error)).toContain('invalid payload');
    });
    expect(jsonFrames(node).filter(frame => frame.type === 'task')).toHaveLength(1);
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

});

describe('warm model identity', () => {
  it('uses the manifest id when the payload carries a public alias', () => {
    // NudeNet's payload model is '320n'/'640m', never the cache id.
    expect(resolveWarmModelId('nudenet', '320n')).toBe('deepghs/nudenet_onnx');
    expect(resolveWarmModelId('nudenet', undefined)).toBe('deepghs/nudenet_onnx');
    // The advertised embedding id is the ONNX binding, not the manifest id.
    expect(resolveWarmModelId('vector-embed', 'onnx-community/embeddinggemma-2-ONNX')).toBe(
      'google/embeddinggemma-2',
    );
    expect(resolveWarmModelId('embed-gemma', undefined)).toBe('google/embeddinggemma-2');
    // The payload model is a public alias, not the pinned manifest id.
    expect(resolveWarmModelId('theia-inference', 'qwen-dlm-4b')).toBe(
      'qwen3-0.6b-diffusion-bd3lm',
    );
  });

  it('keeps the payload model for workloads that pin a real id', () => {
    expect(resolveWarmModelId('ai-inference', 'Xenova/distilbert')).toBe('Xenova/distilbert');
    expect(resolveWarmModelId('ai-inference', undefined)).toBe('');
    expect(resolveWarmModelId('ai-inference', '')).toBe('');
  });

  it('keeps the LoRA adapter identity separate from the base model id', () => {
    expect(resolveWarmTarget('theia-inference', 'qwen-dlm-4b', 'coder')).toEqual({
      modelId: THEIA_DLLM_MODEL_ID,
      adapterId: 'coder',
    });
    expect(resolveWarmTarget('theia-inference', 'qwen-dlm-4b')).toEqual({ modelId: THEIA_DLLM_MODEL_ID });
    expect(resolveWarmTarget('ai-inference', 'Xenova/distilbert', 'coder')).toEqual({ modelId: 'Xenova/distilbert' });
  });
});

describe('node capability parsing', () => {
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
      // model at all.
      expect(parseWarmModels([{ modelId: 'empty', layers: [0, 0] }])).toBeUndefined();
      expect(parseWarmModels([{ modelId: 'huge', layers: [0, 1e9] }])).toBeUndefined();
    });

    it('returns undefined when nothing valid remains', () => {
      expect(parseWarmModels([])).toBeUndefined();
      expect(parseWarmModels('nope')).toBeUndefined();
      expect(parseWarmModels([{ modelId: 'bad' }])).toBeUndefined();
    });

    it('drops an over-long model id', () => {
      expect(parseWarmModels([{ modelId: 'm'.repeat(5_000), layers: [0, 4] }])).toBeUndefined();
    });
  });
});

interface NodeSocket {
  socket: WebSocket;
  frames: Array<string | ArrayBuffer>;
}

async function connectNode(nodeId: string, query: string): Promise<NodeSocket> {
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
async function connectAndAssign(nodeId: string): Promise<{ task: TaskRecord; node: NodeSocket }> {
  const node = await connectNode(nodeId, 'capabilities=ai-inference');
  const task = makeTask();
  await stub.fetch('http://internal/enqueue', { method: 'POST', body: JSON.stringify(task) });
  await new Promise(r => setTimeout(r, 30));
  return { task, node };
}

function jsonFrames(node: NodeSocket): any[] {
  return node.frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f));
}

describe('validateResultPayload enforces the 4 MiB UTF-8 byte budget', () => {
  it('accepts a payload just under the byte cap', () => {
    // A 3-byte CJK character: 3 MiB of text plus JSON overhead stays below 4 MiB.
    const result = { output: 'あ'.repeat(1_000_000) };
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(MAX_RESULT_BYTES);
    expect(validateResultPayload(result)).toEqual({ ok: true });
  });

  it('rejects multibyte text whose code-unit count fits but UTF-8 bytes do not', () => {
    // 1.5M UTF-16 code units used to pass the old `serialized.length` check,
    // while the actual UTF-8 JSON body is ~4.5 MiB.
    const result = { output: 'あ'.repeat(1_500_000) };
    expect(JSON.stringify(result).length).toBeLessThan(MAX_RESULT_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeGreaterThan(MAX_RESULT_BYTES);
    expect(validateResultPayload(result)).toEqual({ ok: false, reason: 'result is too large' });
  });

  it('rejects non-objects and unserializable values', () => {
    expect(validateResultPayload([])).toEqual({ ok: false, reason: 'result must be an object' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateResultPayload(cyclic)).toEqual({ ok: false, reason: 'result is not serializable' });
  });
});
