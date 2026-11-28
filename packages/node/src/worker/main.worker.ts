import type { WorkloadType, NodeModelCacheSnapshot } from '@flaxia/sdk';
import { HEAVY_WORKLOADS } from '@flaxia/sdk';
import { CpuThrottle, DEFAULT_WAIT_SLOT_MS, ThrottleBusyError } from '../executor/throttle';
import { PermanentTaskError, isPermanentTaskError } from '../executor/errors';
import { MAX_TASK_RESULT_BYTES, isResultWithinLimit } from '../executor/resultLimits';
import {
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  hasEnoughWasmMemoryForHeavy,
  probeMaxWasmMemoryBytes,
} from '../executor/memoryProbe';
import { hasWasmSimd } from '../vendor/friedflaxia/init';

let throttle: CpuThrottle | null = null;

/**
 * Workloads that need the heavy memory budget. `ai-preload` is the local
 * Light Inference warm-up path: it is not a protocol `WorkloadType`, but it
 * loads the same multi-hundred-MB translate models and must be gated too.
 */
const HEAVY_EXECUTION: ReadonlySet<string> = new Set<string>([...HEAVY_WORKLOADS, 'ai-preload']);

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
const tokenFlowPaused = new Set<string>();
const tokenFlowWaiters = new Map<string, Set<() => void>>();

function releaseTokenFlow(id: string) {
  tokenFlowPaused.delete(id);
  const waiters = tokenFlowWaiters.get(id);
  if (!waiters) return;
  tokenFlowWaiters.delete(id);
  for (const resolve of waiters) resolve();
}

function waitForTokenFlow(id: string): Promise<void> {
  if (!tokenFlowPaused.has(id)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = tokenFlowWaiters.get(id) ?? new Set<() => void>();
    waiters.add(resolve);
    tokenFlowWaiters.set(id, waiters);
  });
}

// The task this worker is executing right now, if any (tasks are serialized).
let activeTaskId: string | null = null;

/**
 * Duty-cycle accounting starts at the first real work signal (a streamed token
 * or an inference step), not at task dispatch. Model downloads and wasm init
 * run inside `runWorkload`; charging that cold load to the burst made the first
 * yield compute a pause of work * (1/maxLoad - 1) — minutes for a 342 MB model —
 * with no log, so the coordinator timed the task out. The first step still
 * opens the burst and every later step is charged and held to the CPU cap.
 */
let dutyCycleStarted = false;
function beginDutyCycle(): void {
  if (dutyCycleStarted) return;
  dutyCycleStarted = true;
  throttle?.beginWork();
}

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
    await waitForTokenFlow(id);
    postToken(token);
    beginDutyCycle();
    await throttle?.yieldIfOverloaded();
  };
}

// Measured at worker startup: the maximum WebAssembly linear memory this
// runtime can actually commit. We reject heavy workloads when the device cannot
// commit the memory a multi-GB model needs — unlike navigator.deviceMemory,
// which mobile Chrome reports quantized and cannot be trusted for gating. Light
// workloads (cc-extract, file-convert, vector-store, ...) remain available on
// constrained devices.
const WASM_MEMORY_BYTES = probeMaxWasmMemoryBytes();
const CAPABLE = hasEnoughWasmMemoryForHeavy();
console.log(
  `[flaxia-node:worker] startup memory probe wasmMemoryBytes=${WASM_MEMORY_BYTES} capable=${CAPABLE} wasmSimd=${hasWasmSimd()}`,
);

function hasEnoughMemoryForHeavyWorkload(): boolean {
  return hasEnoughWasmMemoryForHeavy();
}

/**
 * An unconfigured LoRA expert is a deployment error: no retry, on this node or
 * another one, can make it succeed. The loader/executor surface it as a plain
 * Error, so classify it here at the task boundary alongside explicit
 * `PermanentTaskError`s before the coordinator decides to requeue.
 */
function isPermanentTheiaError(message: string): boolean {
  return (
    /no adapter pin for expert/.test(message) ||
    /LoRA expert .* is not distributed yet/.test(message) ||
    /adapter expert mismatch/.test(message)
  );
}

// Releasers for lazily-loaded workload modules, so heavyweight model pipelines
// (transformers / onnxruntime, vector indexes) can be dropped after an idle
// period instead of pinning hundreds of MB for the life of the worker.
const cacheReleasers = new Map<string, () => void>();
const cacheSnapshotters = new Map<string, () => NodeModelCacheSnapshot>();
let idleEvictTimer: ReturnType<typeof setTimeout> | null = null;

function releaseLoadedCaches(): void {
  for (const release of cacheReleasers.values()) {
    try { release(); } catch {}
  }
  cacheReleasers.clear();
  // Snapshotters stay registered: they only sample metadata, and dropping them
  // would make the next heartbeat report empty entries even though the models
  // are still warm. A later task re-registers (and overwrites) them anyway.
}

function getModelCacheSnapshot(): NodeModelCacheSnapshot {
  const sampledAt = Date.now();
  // Dedupe after flatMap on the full cache identity: the text and multimodal
  // snapshotters can report the same manifest id, while a different dtype or
  // backend is a distinct download. The adapter id is part of the identity:
  // a LoRA expert shares the base download but is a separate resident model,
  // so without it the expert entry would be swallowed by the base entry and
  // the coordinator would never see a warm expert placement.
  const seen = new Set<string>();
  const entries = [...cacheSnapshotters.values()].flatMap((snapshot) => {
    try { return snapshot().entries; } catch { return []; }
  }).filter((entry) => {
    const key = `${entry.modelId}\u0000${entry.dtype}\u0000${entry.backend}\u0000${entry.adapterId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  return { version: 1, sampledAt, expiresAt: sampledAt + 60_000, entries };
}

function cancelIdleEviction(): void {
  if (idleEvictTimer === null) return;
  clearTimeout(idleEvictTimer);
  idleEvictTimer = null;
}

function armIdleEviction(): void {
  cancelIdleEviction();
  idleEvictTimer = setTimeout(() => {
    idleEvictTimer = null;
    // A timer queued before a task arrived can still win the race. Never drop
    // caches from under a running workload: defer to the next idle period
    // instead (the task's `finally` will re-arm again when it completes).
    if (activeTaskId !== null) {
      armIdleEviction();
      return;
    }
    releaseLoadedCaches();
  }, IDLE_EVICT_MS);
}

async function runWorkload(
  workload: WorkloadType,
  payload: unknown,
  emitToken: (token: string) => void | Promise<void>,
  hostConfig?: { fileSourceOrigins?: string[]; containerImageOrigins?: string[]; ccRangeOrigins?: string[] },
  yieldToThrottle?: () => void | Promise<void>,
): Promise<unknown> {
  switch (workload) {
    case 'ai-inference': {
      const ai = await import('../workloads/ai-inference');
      cacheReleasers.set(workload, ai.releaseCache);
      cacheSnapshotters.set(workload, ai.getModelCacheSnapshot);
      return await ai.handleAiInference(payload as any, emitToken);
    }
    case 'ai-preload' as WorkloadType: {
      const preload = await import('../workloads/ai-inference');
      cacheReleasers.set('ai-inference', preload.releaseCache);
      cacheSnapshotters.set('ai-inference', preload.getModelCacheSnapshot);
      const req = payload as { task: string; model: string; dtype?: string; device?: string };
      await preload.preloadAiModel(req);
      return { preloaded: true };
    }
    case 'image-process':
      const image = await import('../workloads/image-process');
      return await image.handleImageProcess(payload as any);
    case 'container':
      const container = await import('../workloads/container');
      return await container.handleContainer(
        payload as any,
        hostConfig?.fileSourceOrigins ?? [],
        hostConfig?.containerImageOrigins ?? [],
      );
    case 'vector-embed':
      const embed = await import('../workloads/vector-embed');
      cacheReleasers.set(workload, embed.releaseCache);
      cacheSnapshotters.set(workload, embed.getModelCacheSnapshot);
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
      cacheSnapshotters.set(workload, nudenet.getModelCacheSnapshot);
      return await nudenet.handleNudeNet(payload as any);
    case 'cc-extract':
      const cc = await import('../workloads/cc-extract');
      return await cc.handleCcExtract(payload as any, hostConfig?.ccRangeOrigins ?? []);
    case 'embed-gemma':
      const gemma = await import('../workloads/embed-gemma');
      cacheReleasers.set(workload, gemma.releaseCache);
      cacheSnapshotters.set(workload, gemma.getModelCacheSnapshot);
      return await gemma.handleEmbedGemma(payload as any, yieldToThrottle);
    case 'theia-inference':
      const theia = await import('../workloads/theia');
      cacheReleasers.set(workload, theia.releaseCache);
      cacheSnapshotters.set(workload, theia.getModelCacheSnapshot);
      return await theia.handleTheiaInference(payload, yieldToThrottle);
    default:
      throw new Error(`Unknown workload type: ${workload}`);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;

  if (data?.type === 'token-flow') {
    const id = typeof data.id === 'string' ? data.id : '';
    if (id && activeTaskId === id && typeof data.paused === 'boolean') {
      if (data.paused) tokenFlowPaused.add(id);
      else releaseTokenFlow(id);
    }
    return;
  }

  if (data?.type === 'abort') {
    const id = data.id as string;
    const reason = typeof data.reason === 'string' && data.reason ? data.reason : 'aborted by the coordinator';
    releaseTokenFlow(id);
    if (activeTaskId === id) {
      // Only a task we are actually running can be cancelled; an abort that
      // races its completion would otherwise leave an entry behind forever.
      cancelRequested.set(id, reason);
    }
    return;
  }

  const { id, workload, payload, config } = data;
  // An idle eviction queued before this task arrived must not fire mid-task.
  // The timer is re-armed only by the task's inner `finally` (or the outer
  // catch for failures that never reach it).
  cancelIdleEviction();
  if (config?.theiaAdapterPins) {
    const dllm = await import('../workloads/friedflaxia/dllm');
    dllm.setAdapterPins(config.theiaAdapterPins);
  }
  const taskStartedAt = performance.now();
  activeTaskId = id;
  dutyCycleStarted = false;
  releaseTokenFlow(id);

  try {
    if (!throttle) {
      throttle = new CpuThrottle(config?.maxCpuLoad);
    }

    console.log(`[flaxia-node:worker] task start id=${id} workload=${workload}`);

    // Defense in depth: the orchestrator is told (via capabilities) not to route
    // a heavy workload to an incapable node, but if one still arrives, reject it
    // here before any model is loaded so the device is never killed. Light
    // workloads (e.g. cc-extract) remain runnable on low-memory devices.
    if (HEAVY_EXECUTION.has(workload as WorkloadType) && !hasEnoughMemoryForHeavyWorkload()) {
      throw new PermanentTaskError(
        `${workload}: node incapable: insufficient WASM memory (${WASM_MEMORY_BYTES} bytes < ${HEAVY_WORKLOAD_WASM_MEMORY_BYTES})`,
        'NODE_INCAPABLE',
      );
    }

    await waitForCpuSlot();

    // Mid-execution limiting is started lazily by `beginDutyCycle()` on the
    // first token/step, after any model download and wasm init have finished.
    // The pre-task gate alone cannot stop a 10-minute generation from pinning
    // a core at 100%; the yields between tokens/batches hold the duty cycle.

    const heartbeat = setInterval(() => {
      self.postMessage({
        id,
        type: 'heartbeat',
        cpuLoad: throttle?.lastMeasuredLoad ?? 0,
        modelCache: getModelCacheSnapshot(),
      });
    }, 10000);

    const taskStart = performance.now();
    try {
      const emitToken = createTokenSink(id);
      const fileSourceOrigins = Array.isArray(config?.fileSourceOrigins)
        ? config.fileSourceOrigins.filter((origin: unknown): origin is string => typeof origin === 'string')
        : [];
      const containerImageOrigins = Array.isArray(config?.containerImageOrigins)
        ? config.containerImageOrigins.filter((origin: unknown): origin is string => typeof origin === 'string')
        : [];
      const ccRangeOrigins = Array.isArray(config?.ccRangeOrigins)
        ? config.ccRangeOrigins.filter((origin: unknown): origin is string => typeof origin === 'string')
        : [];
      const result = await runWorkload(
        workload as WorkloadType,
        payload,
        emitToken,
        { fileSourceOrigins, containerImageOrigins, ccRangeOrigins },
        async () => {
          beginDutyCycle();
          await throttle?.yieldIfOverloaded();
        },
      );

      if (!isResultWithinLimit(result)) {
        throw new Error(
          `${workload}: result exceeds the ${MAX_TASK_RESULT_BYTES} byte limit; refused before posting to the main thread`,
        );
      }
      self.postMessage({ id, type: 'done', result, modelCache: getModelCacheSnapshot() });
      console.log(
        `[flaxia-node:worker] task done id=${id} workload=${workload} durationMs=${Math.round(performance.now() - taskStartedAt)}`,
      );
    } finally {
      activeTaskId = null;
      cancelRequested.delete(id);
      releaseTokenFlow(id);
      clearInterval(heartbeat);
      // A task that fails before its first token/step never opened the burst;
      // close it here so cold-load wall time is not charged as CPU work either.
      beginDutyCycle();
      throttle.markTaskComplete(performance.now() - taskStart);
      armIdleEviction();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const errRec = err as unknown as { code?: unknown; status?: unknown; detail?: unknown };
    const errorCode = typeof errRec?.code === 'string' ? errRec.code : undefined;
    const errorStatus = typeof errRec?.status === 'number' ? errRec.status : undefined;
    const detail = typeof errRec?.detail === 'string' ? errRec.detail : undefined;
    const permanent = isPermanentTaskError(err) || isPermanentTheiaError(error);
    console.error(`[flaxia-node:worker] task error id=${id} workload=${workload} error=${error} permanent=${permanent}`);
    if (activeTaskId === id) activeTaskId = null;
    releaseTokenFlow(id);
    self.postMessage({ id, type: 'error', error, errorCode, errorStatus, permanent, detail, modelCache: getModelCacheSnapshot() });
    // Failures before the inner try/finally (e.g. CPU slot rejection) never
    // reach its re-arm, so the idle timer must be restored here as well.
    armIdleEviction();
  }
};
