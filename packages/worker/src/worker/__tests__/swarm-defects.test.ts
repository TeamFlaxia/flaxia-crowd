/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Regression tests for `swarm-inference`, written from the
 * feature/swarm-inference quality review and kept after the fixes landed.
 *
 * Every test here encodes the behaviour we WANT. Do not weaken a test in this
 * file to make the suite green — if one of these starts failing, the defect it
 * documents has come back.
 *
 *   H1  invalid `swarm` options must not crash/wedge the scheduler
 *   M2  a rejected host plan must not stall the session silently
 *   M5  `SwarmOptions.preferWarm` / warm model ranges drive node selection
 *   M9  `TaskRecord.swarmSession` must not outlive the session
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { SwarmChainNode, TaskRecord } from '@flaxia/sdk';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    COORDINATOR: DurableObjectNamespace;
  }
}

let stub: DurableObjectStub;
let coordinatorCounter = 0;

function newStub(): DurableObjectStub {
  coordinatorCounter++;
  return env.COORDINATOR.get(env.COORDINATOR.idFromName(`defect-coordinator-${coordinatorCounter}`));
}

const TENANT = 'tenant-test';

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

/** Tenant-scoped task lookup (records are stored per tenant). */
async function getTask(id: string, tenantId = TENANT): Promise<TaskRecord> {
  return stub.fetch(`http://internal/task/${tenantId}/${id}`).then((r) => r.json() as Promise<TaskRecord>);
}

/** Seed task records under their tenant-scoped keys plus the id -> tenant index. */
async function seedTasks(storage: DurableObjectStorage, tasks: TaskRecord[]) {
  for (const task of tasks) {
    await storage.put(`task:${task.tenantId}:${task.id}`, task);
    await storage.put(`taskindex:${task.id}`, task.tenantId);
  }
}

async function withStorage<T>(fn: (storage: DurableObjectStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as any).ctx.storage));
}

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function swarmChainFor(init: any): SwarmChainNode[] {
  const members = init.members as Array<{ nodeId: string }>;
  return members.map((m, i) => ({
    nodeId: m.nodeId,
    role: i === 0 ? ('host' as const) : ('worker' as const),
    slice:
      i === 0
        ? { start: 0, end: 6, hasEmbed: true, hasHead: true }
        : { start: 6, end: 8, hasEmbed: false, hasHead: false },
  }));
}

/** Seed nodes + pending tasks, then expose the scheduler entry point. */
async function seed(nodes: Array<{ id: string; query: string }>, tasks: TaskRecord[]) {
  stub = newStub();
  for (const n of nodes) await connectNode(n.id, n.query);
  await withStorage(async (storage) => {
    await seedTasks(storage, tasks);
    await storage.put('queue:pending', tasks.map((t) => t.id));
    await storage.put('queue:processing', []);
    await storage.put('nodes:idle', nodes.map((n) => n.id));
  });
  return () =>
    runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).tryAssignAll();
    });
}

const SWARM_NODE = 'capabilities=swarm-inference&webgpu=true&wasm=4000000000';

describe('H1: malformed swarm options must not break the scheduler', () => {
  it('does not throw when swarm.minNodes / swarm.maxNodes are not numbers', async () => {
    // A payload is unvalidated user input: `Math.floor("abc")` is NaN, and the
    // NaN then flows into `eligible.length < minNodes` (never true) and
    // `eligible.slice(0, Math.min(maxNodes, ...))` (never true), so the
    // assignment path must not be allowed to blow up on it.
    const swarmTask = makeTask({
      workload: 'swarm-inference',
      payload: {
        model: 'qwen3.5-2b',
        prompt: 'hi',
        swarm: { minNodes: 'abc', maxNodes: { huge: true } },
      } as any,
    });
    const runAssign = await seed(
      [
        { id: 'sw1', query: SWARM_NODE },
        { id: 'sw2', query: SWARM_NODE },
        { id: 'plain', query: 'capabilities=ai-inference' },
      ],
      [swarmTask, makeTask()],
    );

    await expect(runAssign()).resolves.toBeUndefined();
  });

  it('keeps assigning unrelated tasks when a swarm task carries bad options', async () => {
    const swarmTask = makeTask({
      workload: 'swarm-inference',
      payload: { model: 'qwen3.5-2b', prompt: 'hi', swarm: { minNodes: 'abc' } } as any,
    });
    const plainTask = makeTask();
    const runAssign = await seed(
      [
        { id: 'sw1', query: SWARM_NODE },
        { id: 'sw2', query: SWARM_NODE },
        { id: 'plain', query: 'capabilities=ai-inference' },
      ],
      [swarmTask, plainTask],
    );

    // The bad swarm task is queued first: today it throws inside the loop and
    // the ai-inference task behind it is never reached.
    await runAssign();

    const plain = await getTask(plainTask.id);
    expect(plain.status).toBe('processing');

    // The swarm task itself must end up resolved one way or another — assigned
    // with coerced defaults, or failed — instead of wedging in `pending`.
    const swarm = await getTask(swarmTask.id);
    expect(['processing', 'failed']).toContain(swarm.status);
  });
});

describe('M2: a rejected host plan must not stall the session silently', () => {
  async function setup() {
    stub = newStub();
    // n2 must be the strongest device, otherwise the host role (and therefore
    // `swarm-init`) goes to n1.
    const n1 = await connectNode('n1', 'capabilities=swarm-inference&webgpu=true&wasm=4000000000');
    const n2 = await connectNode('n2', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000');
    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3.5-2b', prompt: 'hi' } });
    await withStorage(async (storage) => {
      await seedTasks(storage, [task]);
      await storage.put('queue:pending', [task.id]);
      await storage.put('queue:processing', []);
      await storage.put('nodes:idle', ['n1', 'n2']);
    });
    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).tryAssignAll();
    });
    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    return { task, n1, n2, init };
  }

  it('tells the host when its plan is invalid instead of ignoring it', async () => {
    const { n2, init } = await setup();

    // A gap between slice 0-3 and slice 4-8: `isValidSwarmChain` rejects it.
    const broken: SwarmChainNode[] = [
      { nodeId: 'n2', role: 'host', slice: { start: 0, end: 3, hasEmbed: true, hasHead: true } },
      { nodeId: 'n1', role: 'worker', slice: { start: 4, end: 8, hasEmbed: false, hasHead: false } },
    ];
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: broken }));
    await sleep(100);

    // Today the coordinator returns without a word: no `swarm-error`, no
    // failure — every member stays `busy` until the 30 minute timeout.
    const errors = jsonFrames(n2).filter((f) => f.type === 'swarm-error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ sessionId: init.sessionId });
  });
});

describe('M5: warm nodes must be preferred', () => {
  it('includes a node that already holds the model when preferWarm is on', async () => {
    stub = newStub();
    const warm = JSON.stringify([{ modelId: 'qwen3.5-2b', layers: [0, 27] }]);
    // The warm node is deliberately the weakest device so capacity sorting
    // alone would drop it once maxNodes caps the chain at two.
    const nodes = await Promise.all([
      connectNode('big1', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000'),
      connectNode('big2', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000'),
      connectNode('mid', 'capabilities=swarm-inference&webgpu=true&wasm=6000000000'),
      connectNode('cold', 'capabilities=swarm-inference&webgpu=true&wasm=5000000000'),
      connectNode('warm', `capabilities=swarm-inference&webgpu=true&wasm=1000000000&warmModels=${encodeURIComponent(warm)}`),
    ]);
    const task = makeTask({
      workload: 'swarm-inference',
      payload: { model: 'qwen3.5-2b', prompt: 'hi', swarm: { maxNodes: 2 } } as any,
    });
    await withStorage(async (storage) => {
      await seedTasks(storage, [task]);
      await storage.put('queue:pending', [task.id]);
      await storage.put('queue:processing', []);
      await storage.put('nodes:idle', ['big1', 'big2', 'mid', 'cold', 'warm']);
    });
    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).tryAssignAll();
    });

    const init = jsonFrames(nodes[4]).find((f) => f.type === 'swarm-init');
    // `SwarmOptions.preferWarm` defaults to true and the node already has the
    // weights cached, so it must survive the maxNodes cut — it never does today
    // because `warmModels` is stored and then ignored by the selector.
    expect(init).toBeTruthy();
    expect(init.members.map((m: any) => m.nodeId)).toContain('warm');
  });
});

describe('M9: swarmSession must not outlive the session', () => {
  it('clears TaskRecord.swarmSession once the task is done', async () => {
    stub = newStub();
    // n2 must win the capacity sort to become the host.
    const n1 = await connectNode('n1', 'capabilities=swarm-inference&webgpu=true&wasm=4000000000');
    const n2 = await connectNode('n2', 'capabilities=swarm-inference&webgpu=true&wasm=8000000000');
    const task = makeTask({ workload: 'swarm-inference', payload: { model: 'qwen3.5-2b', prompt: 'hi' } });
    await withStorage(async (storage) => {
      await seedTasks(storage, [task]);
      await storage.put('queue:pending', [task.id]);
      await storage.put('queue:processing', []);
      await storage.put('nodes:idle', ['n1', 'n2']);
    });
    await runInDurableObject(stub, async (instance) => {
      (instance as any).pendingCache = null;
      (instance as any).processingCache = null;
      await (instance as any).tryAssignAll();
    });

    const init = jsonFrames(n2).find((f) => f.type === 'swarm-init')!;
    n2.socket.send(JSON.stringify({ type: 'swarm-plan', sessionId: init.sessionId, chain: swarmChainFor(init) }));
    await sleep(30);
    n1.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    n2.socket.send(JSON.stringify({ type: 'swarm-ready', sessionId: init.sessionId }));
    await sleep(30);
    n2.socket.send(JSON.stringify({
      type: 'result', taskId: task.id, sessionId: init.sessionId, payload: { output: 'ok' }, attemptId: init.attemptId,
    }));
    await sleep(30);

    const stored = await getTask(task.id);
    expect(stored.status).toBe('done');
    // The stale chain stays on the record for the lifetime of the task, where
    // `relaySwarmFrame` keeps reading it (and a retry would route frames on a
    // chain from a previous attempt).
    expect(stored.swarmSession).toBeUndefined();
  });
});
