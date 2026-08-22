import type { WorkloadType } from '@flaxia/sdk';
import { CpuThrottle } from '../executor/throttle';
import {
  HEAVY_WORKLOAD_WASM_MEMORY_BYTES,
  hasEnoughWasmMemoryForHeavy,
  probeMaxWasmMemoryBytes,
} from '../executor/memoryProbe';

let throttle: CpuThrottle | null = null;

// Workloads that load large WebAssembly models / heavy compute into this worker.
const HEAVY_WORKLOADS: ReadonlySet<WorkloadType> = new Set([
  'ai-inference',
  'vector-embed',
  'vector-query',
  'nudenet',
  'image-process',
  'container',
]);

const IDLE_EVICT_MS = 60_000;

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
  emitToken: (token: string) => void,
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

self.onmessage = async (e: MessageEvent) => {
  const { id, workload, payload, config } = e.data;
  const taskStartedAt = performance.now();

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

    await throttle.waitForSlot();

    const heartbeat = setInterval(() => {
      self.postMessage({
        id,
        type: 'heartbeat',
        cpuLoad: throttle?.lastMeasuredLoad ?? 0,
      });
    }, 10000);

    const taskStart = performance.now();
    try {
      const emitToken = (token: string) => {
        self.postMessage({ id, type: 'token', token });
      };
      const result = await runWorkload(workload as WorkloadType, payload, emitToken);

      self.postMessage({ id, type: 'done', result });
      console.log(
        `[flaxia-node:worker] task done id=${id} workload=${workload} durationMs=${Math.round(performance.now() - taskStartedAt)}`,
      );
    } finally {
      clearInterval(heartbeat);
      throttle.markTaskComplete(performance.now() - taskStart);
      armIdleEviction();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[flaxia-node:worker] task error id=${id} workload=${workload} error=${error}`);
    self.postMessage({ id, type: 'error', error });
  }
};