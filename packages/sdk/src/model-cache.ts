/** Maximum number of executable cache entries reported by one node. */
export const MAX_NODE_MODEL_CACHE_ENTRIES = 8;
/** Coordinator treats a cache snapshot as stale after one minute. */
export const NODE_MODEL_CACHE_TTL_MS = 60_000;

export type ModelCacheState = 'loading' | 'ready' | 'evicting' | 'failed';
export type ModelCacheBackend = 'wasm' | 'cpu' | 'webgpu';

export interface ModelCacheEntryStatus {
  modelId: string;
  revision: string;
  dtype: string;
  backend: ModelCacheBackend;
  layerRange?: [number, number];
  state: ModelCacheState;
  referenceCount: number;
}

/** Short-lived snapshot of executable models currently resident in memory. */
export interface NodeModelCacheSnapshot {
  version: 1;
  sampledAt: number;
  expiresAt: number;
  entries: ModelCacheEntryStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is ModelCacheEntryStatus {
  if (!isRecord(value) || typeof value.modelId !== 'string' || !value.modelId || value.modelId.length > 128 ||
      typeof value.revision !== 'string' || !value.revision || value.revision.length > 128 ||
      typeof value.dtype !== 'string' || !value.dtype || value.dtype.length > 32 ||
      (value.backend !== 'wasm' && value.backend !== 'cpu' && value.backend !== 'webgpu') ||
      (value.state !== 'loading' && value.state !== 'ready' && value.state !== 'evicting' && value.state !== 'failed') ||
      !Number.isInteger(value.referenceCount) || (value.referenceCount as number) < 0 || (value.referenceCount as number) > 64) {
    return false;
  }
  if (value.layerRange === undefined) return true;
  const range = value.layerRange;
  return Array.isArray(range) && range.length === 2 && Number.isInteger(range[0]) && Number.isInteger(range[1]) &&
    range[0] >= 0 && range[1] > range[0] && range[1] <= 1024;
}

export function isNodeModelCacheSnapshot(value: unknown, now = Date.now()): value is NodeModelCacheSnapshot {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.sampledAt) ||
      !Number.isSafeInteger(value.expiresAt) || !Array.isArray(value.entries) ||
      value.entries.length > MAX_NODE_MODEL_CACHE_ENTRIES || !value.entries.every(isEntry)) return false;
  const sampledAt = value.sampledAt as number;
  const expiresAt = value.expiresAt as number;
  return sampledAt <= now + 5_000 && sampledAt >= now - NODE_MODEL_CACHE_TTL_MS &&
    expiresAt > now && expiresAt > sampledAt && expiresAt - sampledAt <= NODE_MODEL_CACHE_TTL_MS;
}
