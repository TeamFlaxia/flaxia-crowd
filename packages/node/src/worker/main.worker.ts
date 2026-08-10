import type { WorkloadType } from '@flaxia/sdk';
import { CpuThrottle } from '../executor/throttle';

let throttle: CpuThrottle | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, workload, payload, config } = e.data;
  const taskStartedAt = performance.now();

  try {
    if (!throttle) {
      throttle = new CpuThrottle(config?.maxCpuLoad);
    }

    console.log(`[flaxia-node:worker] task start id=${id} workload=${workload}`);
    await throttle.waitForSlot();

    const heartbeat = setInterval(() => {
      self.postMessage({
        id,
        type: 'heartbeat',
        cpuLoad: throttle?.lastMeasuredLoad ?? 0,
      });
    }, 10000);

    try {
      let result;
      const emitToken = (token: string) => {
        self.postMessage({ id, type: 'token', token });
      };
      switch (workload as WorkloadType) {
        case 'ai-inference':
          const { handleAiInference } = await import('../workloads/ai-inference');
          result = await handleAiInference(payload, emitToken);
          break;
        case 'image-process':
          const { handleImageProcess } = await import('../workloads/image-process');
          result = await handleImageProcess(payload);
          break;
        case 'container':
          const { handleContainer } = await import('../workloads/container');
          result = await handleContainer(payload);
          break;
        case 'vector-embed':
          const { handleVectorEmbed } = await import('../workloads/vector-embed');
          result = await handleVectorEmbed(payload);
          break;
        case 'vector-store':
          const { handleVectorStore } = await import('../workloads/vector-store');
          result = await handleVectorStore(payload);
          break;
        case 'vector-query':
          const { handleVectorQuery } = await import('../workloads/vector-query');
          result = await handleVectorQuery(payload);
          break;
        case 'nudenet':
          const { handleNudeNet } = await import('../workloads/nudenet');
          result = await handleNudeNet(payload);
          break;
        default:
          throw new Error(`Unknown workload type: ${workload}`);
      }

      self.postMessage({ id, type: 'done', result });
      console.log(
        `[flaxia-node:worker] task done id=${id} workload=${workload} durationMs=${Math.round(performance.now() - taskStartedAt)}`,
      );
    } finally {
      clearInterval(heartbeat);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[flaxia-node:worker] task error id=${id} workload=${workload} error=${error}`);
    self.postMessage({ id, type: 'error', error });
  }
};
