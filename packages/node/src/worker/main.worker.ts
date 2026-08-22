import type { WorkloadType } from '@flaxia/sdk';
import { CpuThrottle } from '../executor/throttle';

let throttle: CpuThrottle | null = null;

// Workloads that load large WebAssembly models / heavy compute into this worker.
// These are rejected when the device does not report >= 4 GB of device memory so
// that a low-memory or mobile WebView is never killed by a giant model load.
const HEAVY_WORKLOADS: ReadonlySet<WorkloadType> = new Set([
  'ai-inference',
  'vector-embed',
  'vector-query',
  'nudenet',
  'image-process',
  'container',
]);

const IDLE_EVICT_MS = 60_000;

function hasEnoughMemoryForHeavyWorkload(): boolean {
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // `deviceMemory` is only defined on desktop Chrome; Android WebViews and mobile
  // browsers leave it undefined. Unknown memory => do not run heavy workloads.
  return typeof deviceMemory === 'number' && deviceMemory >= 4;
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

    if (HEAVY_WORKLOADS.has(workload as WorkloadType) && !hasEnoughMemoryForHeavyWorkload()) {
      const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      throw new Error(`${workload}: insufficient device memory (deviceMemory=${dm ?? 'unknown'})`);
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