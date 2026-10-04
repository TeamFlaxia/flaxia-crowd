import type { WorkloadType, SwarmInitMessage, SwarmSliceMessage } from '@flaxia/sdk';
import { HEAVY_WORKLOADS } from '@flaxia/sdk';
import { CpuThrottle, DEFAULT_WAIT_SLOT_MS, ThrottleBusyError } from '../executor/throttle';
import {
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  hasEnoughWasmMemoryForHeavy,
  probeMaxWasmMemoryBytes,
} from '../executor/memoryProbe';
import { SwarmController } from '../swarm/controller';
import { createSwarmRuntime } from '../swarm/runtime';
import { isSwarmControlEnvelope } from '../swarm/messages';

let throttle: CpuThrottle | null = null;

/**
 * CPU-budget policy for a task that arrives while the device is saturated.
 *
 * The wait budget must stay well under the WorkerPool timeout (300s default)
 * because the worker owns the whole budget; when it is exhausted the task is
 * rejected with a retryable error instead of being force-started at 100% CPU.
 */
const SLOT_WAIT_BUDGET_MS = DEFAULT_WAIT_SLOT_MS;
const SLOT_WAIT_RETRIES = 1;
const SLOT_RETRY_COOLDOWN_MS = 15_000;

/** Task ids the coordinator asked us to abort, with the reason to surface. */
const cancelRequested = new Map<string, string>();

// The active swarm session, if any. One task at a time, so a single slot is
// enough; control messages and frames from the main thread route here.
let activeSwarm: SwarmController | null = null;
let activeSwarmTaskId: string | null = null;
/** The task this worker is executing right now, if any (tasks are serialized). */
let activeTaskId: string | null = null;

const IDLE_EVICT_MS = 60_000;

/**
 * Acquire a CPU slot before starting a task.
 *
 * `waitForSlot()` throws once its budget is exhausted instead of starting the
 * task anyway; this gives the device one bounded cooldown and then fails the
 * task with a retryable marker so the orchestrator can move it to an idle node.
 */
async function waitForCpuSlot(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await throttle!.waitForSlot(SLOT_WAIT_BUDGET_MS);
      return;
    } catch (err) {
      if (!(err instanceof ThrottleBusyError)) throw err;
      if (attempt >= SLOT_WAIT_RETRIES) {
        throw new Error(
          `device CPU busy: ${err.message}; task not started, retry on an idle node (retryable)`,
        );
      }
      console.warn(
        `[flaxia-node:worker] ${err.message}; cooling down ${SLOT_RETRY_COOLDOWN_MS}ms before retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, SLOT_RETRY_COOLDOWN_MS));
    }
  }
}

/**
 * Token sink for streaming workloads.
 *
 * The cancellation check is synchronous so an abort that arrives mid-stream is
 * observed on the very next token (no microtask delay), while the CPU duty
 * cycle yields between tokens so a long generation cannot pin a core.
 */
function createTokenSink(id: string): (token: string) => Promise<void> {
  const postToken = (token: string): void => {
    const cancelled = cancelRequested.get(id);
    if (cancelled !== undefined) throw new Error(cancelled);
    self.postMessage({ id, type: 'token', token });
  };
  return async (token: string): Promise<void> => {
    postToken(token);
    await throttle?.yieldIfOverloaded();
  };
}

// Measured at worker startup: the maximum WebAssembly linear memory this
// runtime can actually commit. We reject heavy workloads (and, as defense in
// depth, EVERY task) when the device cannot commit the memory a multi-GB model
// needs — unlike navigator.deviceMemory, which mobile Chrome reports quantized
// and cannot be trusted for gating.
const WASM_MEMORY_BYTES = probeMaxWasmMemoryBytes();
const CAPABLE = WASM_MEMORY_BYTES >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES;
console.log(
  `[flaxia-node:worker] startup memory probe wasmMemoryBytes=${WASM_MEMORY_BYTES} capable=${CAPABLE}`,
);

function hasEnoughMemoryForHeavyWorkload(): boolean {
  return hasEnoughWasmMemoryForHeavy();
}

// Releasers for lazily-loaded workload modules, so heavyweight model pipelines
// (transformers / onnxruntime, vector indexes) can be dropped after an idle
// period instead of pinning hundreds of MB for the life of the worker.
const cacheReleasers = new Map<string, () => void>();
let idleEvictTimer: ReturnType<typeof setTimeout> | null = null;

function releaseLoadedCaches(): void {
  for (const release of cacheReleasers.values()) {
    try { release(); } catch {}
  }
  cacheReleasers.clear();
}

function armIdleEviction(): void {
  if (idleEvictTimer) clearTimeout(idleEvictTimer);
  idleEvictTimer = setTimeout(() => {
    idleEvictTimer = null;
    releaseLoadedCaches();
  }, IDLE_EVICT_MS);
}

async function runWorkload(
  workload: WorkloadType,
  payload: unknown,
  emitToken: (token: string) => void | Promise<void>,
): Promise<unknown> {
  switch (workload) {
    case 'ai-inference':
      const ai = await import('../workloads/ai-inference');
      cacheReleasers.set(workload, ai.releaseCache);
      return await ai.handleAiInference(payload as any, emitToken);
    case 'image-process':
      const image = await import('../workloads/image-process');
      return await image.handleImageProcess(payload as any);
    case 'container':
      const container = await import('../workloads/container');
      return await container.handleContainer(payload as any);
    case 'vector-embed':
      const embed = await import('../workloads/vector-embed');
      cacheReleasers.set(workload, embed.releaseCache);
      return await embed.handleVectorEmbed(payload as any);
    case 'vector-store':
      const store = await import('../workloads/vector-store');
      cacheReleasers.set(workload, store.releaseCache);
      return await store.handleVectorStore(payload as any);
    case 'vector-query':
      const query = await import('../workloads/vector-query');
      cacheReleasers.set(workload, query.releaseCache);
      return await query.handleVectorQuery(payload as any);
    case 'nudenet':
      const nudenet = await import('../workloads/nudenet');
      cacheReleasers.set(workload, nudenet.releaseCache);
      return await nudenet.handleNudeNet(payload as any);
    default:
      throw new Error(`Unknown workload type: ${workload}`);
  }
}

/** Start a swarm session and resolve when it finishes or fails. */
function startSwarmTask(id: string, initial: SwarmInitMessage | SwarmSliceMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const controller = new SwarmController({
      initial,
      runtime: createSwarmRuntime(),
      sendControl: (message) => (self as any).postMessage({ id, type: 'swarm-message', message }),
      sendFrame: (frame) => (self as any).postMessage({ id, type: 'swarm-frame', frame }, [frame]),
      emitToken: (token) => (self as any).postMessage({ id, type: 'token', token }),
      onDone: (result) => {
        if (activeSwarm === controller) {
          activeSwarm = null;
          activeSwarmTaskId = null;
        }
        resolve(result);
      },
      onError: (error) => {
        if (activeSwarm === controller) {
          activeSwarm = null;
          activeSwarmTaskId = null;
        }
        reject(new Error(error));
      },
    });
    activeSwarm = controller;
    activeSwarmTaskId = id;
    void controller.start();
  });
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;

  if (data?.type === 'swarm-control') {
    // The main thread forwards whatever the coordinator sent; it is untrusted
    // input. Only a well-formed control envelope reaches the session, so a
    // malformed message cannot make the controller act on a bogus slice/plan.
    if (!isSwarmControlEnvelope(data)) {
      console.warn('[flaxia-node:worker] dropped malformed swarm-control message');
      return;
    }
    if (activeSwarm) {
      void activeSwarm.handleControl(data.message);
    }
    return;
  }
  if (data?.type === 'swarm-frame') {
    if (data.frame instanceof ArrayBuffer) {
      activeSwarm?.handleFrame(data.frame);
    } else {
      console.warn('[flaxia-node:worker] dropped malformed swarm-frame message');
    }
    return;
  }
  if (data?.type === 'abort') {
    const id = data.id as string;
    const reason = typeof data.reason === 'string' && data.reason ? data.reason : 'aborted by the coordinator';
    if (activeSwarm && activeSwarmTaskId === id) {
      // Settling the controller posts the error this pool needs to release the
      // slot; nothing waits on this message's reply.
      activeSwarm.abort(reason);
    } else if (activeTaskId === id) {
      // Only a task we are actually running can be cancelled; an abort that
      // races its completion would otherwise leave an entry behind forever.
      cancelRequested.set(id, reason);
    }
    return;
  }

  const { id, workload, payload, config } = data;
  const taskStartedAt = performance.now();
  activeTaskId = id;

  try {
    if (!throttle) {
      throttle = new CpuThrottle(config?.maxCpuLoad);
    }

    console.log(`[flaxia-node:worker] task start id=${id} workload=${workload}`);

    // Defense in depth: the orchestrator is told (via capabilities=[]) not to
    // route any task to an incapable node, but if one still arrives, reject it
    // here before any model is loaded so the device is never killed.
    if (!CAPABLE) {
      throw new Error(`node incapable: insufficient WASM memory (${WASM_MEMORY_BYTES} bytes < ${HEAVY_WORKLOAD_WASM_MEMORY_BYTES}); rejecting all tasks`);
    }

    if (HEAVY_WORKLOADS.has(workload as WorkloadType) && !hasEnoughMemoryForHeavyWorkload()) {
      throw new Error(`${workload}: insufficient WASM memory (${WASM_MEMORY_BYTES} bytes < ${HEAVY_WORKLOAD_WASM_MEMORY_BYTES})`);
    }

    await waitForCpuSlot();

    // Mid-execution limiting: the pre-task gate alone cannot stop a 10-minute
    // generation from pinning a core at 100%, so the streaming path yields
    // between tokens/batches and holds the configured duty cycle.
    throttle.beginWork();

    const heartbeat = setInterval(() => {
      self.postMessage({
        id,
        type: 'heartbeat',
        cpuLoad: throttle?.lastMeasuredLoad ?? 0,
      });
    }, 10000);

    const taskStart = performance.now();
    try {
      const emitToken = createTokenSink(id);
      const result = workload === 'swarm-inference'
        ? await startSwarmTask(id, payload as SwarmInitMessage | SwarmSliceMessage)
        : await runWorkload(workload as WorkloadType, payload, emitToken);

      self.postMessage({ id, type: 'done', result });
      console.log(
        `[flaxia-node:worker] task done id=${id} workload=${workload} durationMs=${Math.round(performance.now() - taskStartedAt)}`,
      );
    } finally {
      activeTaskId = null;
      cancelRequested.delete(id);
      clearInterval(heartbeat);
      throttle.markTaskComplete(performance.now() - taskStart);
      armIdleEviction();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[flaxia-node:worker] task error id=${id} workload=${workload} error=${error}`);
    if (activeTaskId === id) activeTaskId = null;
    self.postMessage({ id, type: 'error', error });
  }
};