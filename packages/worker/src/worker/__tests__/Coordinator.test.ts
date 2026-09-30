import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { SwarmChainNode, TaskRecord } from '@flaxia/sdk';
import { encodeSwarmEnvelope } from '@flaxia/sdk';
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

    const stored = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
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
      await (instance as any).alarm();
    });

    const updated = await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json()) as TaskRecord;
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

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).alarm();
    });

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

    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).alarm();
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
      await (instance as any).alarm();
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
      await (instance as any).alarm();
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

  it('delivers a task frame to a connected node socket', async () => {
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
    expect(frames.some((f) => f.type === 'task' && f.taskId === task.id)).toBe(true);
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
    await withStorage(async (storage) => {
      await storage.put(`task:${task.id}`, task);
      await storage.put('queue:pending', [task.id]);
      await storage.put('queue:processing', []);
      await storage.put('nodes:idle', ['n1', 'n2', 'n3']);
    });
    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).tryAssignAll();
    });
    return { task, n1, n2, n3 };
  }

  it('reserves WebGPU nodes for the chain and sends swarm-init to the strongest (host)', async () => {
    const { task, n1, n2, n3 } = await setup();

    const stored = await stub.fetch(`http://internal/task/${task.id}`).then((r) => r.json() as Promise<TaskRecord>);
    expect(stored.status).toBe('processing');
    // n2 has the most capacity, so it becomes the host.
    expect(stored.assignedNodeId).toBe('n2');

    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init');
    expect(init).toBeTruthy();
    expect(init.taskId).toBe(task.id);
    expect(init.members.map((m: any) => m.nodeId)).toEqual(['n2', 'n1']);
    // The non-WebGPU node is not a member, and only the host is asked to plan.
    expect(jsonFrames(n1).some((f) => f.type === 'swarm-init')).toBe(false);
    expect(jsonFrames(n3).some((f) => f.type === 'swarm-init')).toBe(false);
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
    const stored = await stub.fetch(`http://internal/task/${task.id}`).then((r) => r.json() as Promise<TaskRecord>);
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

  it('relays a binary hidden frame to the next hop', async () => {
    const { n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // Host (n2, index 0) sends a hidden frame; it should reach n1 (index 1).
    n2.socket.send(encodeSwarmEnvelope(init.sessionId, new ArrayBuffer(16)));
    await new Promise((r) => setTimeout(r, 30));
    expect(n1.frames.some((f) => typeof f !== 'string' && (f as ArrayBuffer).byteLength === 56)).toBe(true);
  });

  it('accepts only the host result and releases every member', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await new Promise((r) => setTimeout(r, 30));

    // A worker's result is ignored.
    n1.socket.send(JSON.stringify({ type: 'result', taskId: task.id, sessionId: init.sessionId, payload: { output: 'wrong' } }));
    await new Promise((r) => setTimeout(r, 20));
    let stored = await stub.fetch(`http://internal/task/${task.id}`).then((r) => r.json() as Promise<TaskRecord>);
    expect(stored.status).toBe('processing');

    // The host completes the task.
    n2.socket.send(JSON.stringify({ type: 'result', taskId: task.id, sessionId: init.sessionId, payload: { output: 'ok', tokens: [1] } }));
    await new Promise((r) => setTimeout(r, 20));
    stored = await stub.fetch(`http://internal/task/${task.id}`).then((r) => r.json() as Promise<TaskRecord>);
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

  it('stops every member when one of them fails', async () => {
    const { task, n1, n2 } = await setup();
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n1.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: init.sessionId, error: 'member blew up' }));
    await new Promise((r) => setTimeout(r, 50));

    // Every member is still running the session; the failing one already
    // stopped, the others would otherwise sit here until the task timeout.
    for (const node of [n1, n2]) {
      const aborts = jsonFrames(node).filter((f) => f.type === 'abort');
      expect(aborts.length).toBeGreaterThan(0);
      expect(aborts[0]).toMatchObject({ taskId: task.id, error: 'member blew up' });
    }

    // The failure is transient: the task burns one retry and is reassigned
    // straight away (both members are idle again), rather than failing.
    const stored = await stub.fetch(`http://internal/task/${task.id}`).then((r) => r.json() as Promise<TaskRecord>);
    expect(stored.retryCount).toBe(1);
    expect(['pending', 'processing']).toContain(stored.status);
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
    expect(await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json())).toMatchObject({
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
    n2.socket.send(JSON.stringify({ type: 'result', taskId: task.id, sessionId: 'old-session', payload: {} }));
    n1.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: 'old-session', error: 'old' }));
    n3.socket.send(JSON.stringify({ type: 'error', taskId: task.id, sessionId: init.sessionId, error: 'unrelated' }));
    n2.socket.send(encodeSwarmEnvelope('old-session', new ArrayBuffer(16)));
    await new Promise(r => setTimeout(r, 30));
    expect(jsonFrames(n2).some(f => f.type === 'swarm-start')).toBe(false);
    expect(n1.frames.some(f => typeof f !== 'string')).toBe(false);
    expect(await stub.fetch(`http://internal/task/${task.id}`).then(r => r.json())).toMatchObject({
      status: 'processing', retryCount: 0,
    });
    n1.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    await new Promise(r => setTimeout(r, 20));
    expect(jsonFrames(n2).some(f => f.type === 'swarm-start')).toBe(true);
  });
});
