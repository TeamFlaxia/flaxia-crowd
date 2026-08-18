import type { VectorQueryPayload, VectorQueryResult } from '@flaxia/sdk';
import { VectorStoreEngine } from '../vector-store/VectorStoreEngine';

let engine: VectorStoreEngine | null = null;

export const releaseCache = (): void => {
  engine = null;
};

async function getEngine(): Promise<VectorStoreEngine> {
  if (!engine) {
    engine = new VectorStoreEngine();
    await engine.initialize();
  }
  return engine;
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
