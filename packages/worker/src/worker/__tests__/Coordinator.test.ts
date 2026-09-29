import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { TaskRecord } from '@flaxia/sdk';
import { MAX_RETRIES } from '../Coordinator';
import { parseSwarmCapabilities, parseWarmModels } from '../../crowd/index';

interface NodeRecord {
  id: string;
  status: "idle" | "busy";
  capabilities: string[];
  cpuLoad: number;
  connectedAt: number;
  lastPongAt: number;
  currentTaskId?: string;
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

let stub: DurableObjectStub;
let coordinatorCounter = 0;

function newStub(): DurableObjectStub {
  coordinatorCounter++;
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(`test-coordinator-${coordinatorCounter}`));
}

async function withStorage<T>(fn: (storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as any).ctx.storage));
}

async function seedProcessingTask(task: TaskRecord, node: NodeRecord) {
  await withStorage(async (storage) => {
    await storage.put(`task:${task.id}`, task);
    await storage.put(`node:${node.id}`, node);
    await storage.put('queue:pending', []);
    await storage.put('queue:processing', [task.id]);
    await storage.put('nodes:idle', []);
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

    const stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json());
    expect(stored.id).toBe(task.id);
    expect(stored.status).toBe('pending');
    expect(stored.workload).toBe('ai-inference');
  });

  it('rejects malformed JSON on enqueue', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/enqueue', {
      method: 'POST',
      body: '{ not valid json',
    });
    expect(resp.status).toBe(400);
  });

  it('returns 404 for an unknown task', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/task/does-not-exist');
    expect(resp.status).toBe(404);
  });

  it('returns 404 when subscribing to an unknown task', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/subscribe?taskId=does-not-exist');
    expect(resp.status).toBe(404);
  });

  it('returns 400 when subscribing without taskId', async () => {
    stub = newStub();
    const resp = await stub.fetch('http://internal/subscribe');
    expect(resp.status).toBe(400);
  });

  it('requeues a timed-out processing task and releases its node', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 120000 });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await instance.alarm();
    });

    const updated = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
    expect(updated.status).toBe('pending');
    expect(updated.retryCount).toBe(1);
    expect(updated.assignedNodeId).toBeUndefined();

    await withStorage(async (storage) => {
      const released = await storage.get<NodeRecord>('node:node-1');
      expect(released.status).toBe('idle');
      expect(released.currentTaskId).toBeUndefined();
      const idle = await storage.get<string[]>('nodes:idle');
      expect(idle).toContain('node-1');
    });
  });

  it('fails a task permanently once MAX_RETRIES is reached', async () => {
    stub = newStub();
    const task = makeTask({ status: 'processing', assignedNodeId: 'node-1', assignedAt: Date.now() - 120000, retryCount: MAX_RETRIES });
    const node: NodeRecord = {
      id: 'node-1', status: 'busy', capabilities: ['ai-inference'],
      cpuLoad: 0, connectedAt: Date.now(), lastPongAt: Date.now(), currentTaskId: task.id,
    };
    await seedProcessingTask(task, node);

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await instance.alarm();
    });

    const updated = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
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

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await instance.alarm();
    });

    const failed = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
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

    const after = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
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

    let stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();

    // A capable, non-low-memory node can still pick it up immediately.
    await stub.fetch('http://internal/ws?nodeId=node-ok&capabilities=ai-inference', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
    expect(stored.status).toBe('processing');
    expect(stored.assignedNodeId).toBe('node-ok');
  });

  it('never routes swarm-inference to a node without WebGPU', async () => {
    stub = newStub();
    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3-1.7b', prompt: 'hi' } });

    // Advertises the swarm capability but has no WebGPU adapter.
    await stub.fetch('http://internal/ws?nodeId=node-nogpu&capabilities=swarm-inference', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    await withStorage(async (storage) => {
      await storage.put(`task:${task.id}`, task);
      await storage.put('queue:pending', [task.id]);
      await storage.put('queue:processing', []);
      await storage.put('nodes:idle', ['node-nogpu']);
    });

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await instance.alarm();
    });

    let stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
    expect(stored.status).toBe('pending');
    expect(stored.assignedNodeId).toBeUndefined();

    // A WebGPU-capable node can take the same task.
    await stub.fetch('http://internal/ws?nodeId=node-gpu&capabilities=swarm-inference&webgpu=true', {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });

    stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
    expect(stored.status).toBe('processing');
    expect(stored.assignedNodeId).toBe('node-gpu');
  });

  it('stores advertised WebGPU and warm-model capabilities', async () => {
    stub = newStub();
    const warm = JSON.stringify([{ modelId: 'qwen3-1.7b', layers: [0, 13] }]);

    const resp = await stub.fetch(
      `http://internal/ws?nodeId=node-cap&capabilities=swarm-inference&webgpu=true&gpu=apple%20m1&maxBuffer=134217728&warmModels=${encodeURIComponent(warm)}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } },
    );
    expect(resp.status).toBe(101);

    interface StoredNode {
      webgpu?: boolean;
      gpuArchitecture?: string;
      maxStorageBufferBindingSize?: number;
      warmModels?: unknown;
    }

    await withStorage(async (storage) => {
      const node = await storage.get<StoredNode>('node:node-cap');
      expect(node?.webgpu).toBe(true);
      expect(node?.gpuArchitecture).toBe('apple m1');
      expect(node?.maxStorageBufferBindingSize).toBe(134217728);
      expect(node?.warmModels).toEqual([{ modelId: 'qwen3-1.7b', layers: [0, 13] }]);
    });
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

    it('returns undefined when nothing valid remains', () => {
      expect(parseWarmModels([])).toBeUndefined();
      expect(parseWarmModels('nope')).toBeUndefined();
      expect(parseWarmModels([{ modelId: 'bad' }])).toBeUndefined();
    });
  });
});
