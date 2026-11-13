import type { VectorStorePayload, VectorStoreResult } from '@flaxia/sdk';
import type { VectorStoreEngine } from '../vector-store/VectorStoreEngine';
import { getVectorEngine, releaseVectorEngine } from '../vector-store/sharedEngine';

export const releaseCache = (): void => {
  releaseVectorEngine();
};

async function getEngine(): Promise<VectorStoreEngine> {
  return getVectorEngine();
}

export async function handleVectorStore(payload: VectorStorePayload): Promise<VectorStoreResult> {
  const eng = await getEngine();
  const startedAt = performance.now();
  try {
    const result = await eng.store(payload);
    console.log(`[flaxia-node] vector-store: done durationMs=${Math.round(performance.now() - startedAt)}`);
    return result;
  } catch (err) {
    console.error(`[flaxia-node] vector-store: failed error=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

export async function handleVectorStoreAssignShard(rangeStart: number, rangeEnd: number): Promise<void> {
  const eng = await getEngine();
  await eng.assignShard(rangeStart, rangeEnd);
}
