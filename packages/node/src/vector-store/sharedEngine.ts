import { VectorStoreEngine } from './VectorStoreEngine';

let engine: VectorStoreEngine | null = null;

/**
 * The node-local vector engine is a process-wide singleton.
 *
 * `vector-store` and `vector-query` are separate workload modules, but two
 * engines would hold two independent HNSW graphs (and two IndexedDB
 * connections) in memory. Sharing one engine also lets idle eviction close
 * the database handle exactly once.
 */
export function getVectorEngine(): Promise<VectorStoreEngine> {
  if (!engine) {
    const created = new VectorStoreEngine();
    return created.initialize().then(() => {
      engine = created;
      return created;
    });
  }
  return Promise.resolve(engine);
}

/** Drop the shared engine and close its IndexedDB connection. */
export function releaseVectorEngine(): void {
  const current = engine;
  engine = null;
  current?.close();
}
