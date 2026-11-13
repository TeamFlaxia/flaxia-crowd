import type { VectorQueryPayload, VectorQueryResult } from '@flaxia/sdk';
import type { VectorStoreEngine } from '../vector-store/VectorStoreEngine';
import { getVectorEngine, releaseVectorEngine } from '../vector-store/sharedEngine';

export const releaseCache = (): void => {
  releaseVectorEngine();
};

async function getEngine(): Promise<VectorStoreEngine> {
  return getVectorEngine();
}

export async function handleVectorQuery(payload: VectorQueryPayload): Promise<VectorQueryResult> {
  const eng = await getEngine();
  const startedAt = performance.now();
  try {
    const result = await eng.query(payload);
    console.log(`[flaxia-node] vector-query: done durationMs=${Math.round(performance.now() - startedAt)}`);
    return result;
  } catch (err) {
    console.error(`[flaxia-node] vector-query: failed error=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
