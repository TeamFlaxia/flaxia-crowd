import type { VectorStorePayload, VectorStoreResult } from '@flaxia/sdk';
import { VectorStoreEngine } from '../vector-store/VectorStoreEngine';

let engine: VectorStoreEngine | null = null;

async function getEngine(): Promise<VectorStoreEngine> {
  if (!engine) {
    engine = new VectorStoreEngine();
    await engine.initialize();
  }
  return engine;
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
