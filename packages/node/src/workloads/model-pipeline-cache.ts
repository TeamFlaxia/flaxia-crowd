import {
  NODE_MODEL_CACHE_TTL_MS,
  type ModelCacheBackend,
  type ModelCacheEntryStatus,
  type NodeModelCacheSnapshot,
} from '@flaxia/sdk';

export const DEFAULT_MODEL_PIPELINE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MODEL_PIPELINE_CACHE_CAPACITY = 2;

export type ModelPipelineDescriptor = Omit<ModelCacheEntryStatus, 'state' | 'referenceCount'>;

interface LoadedModelPipeline<T> {
  value: T;
  descriptor?: Partial<ModelPipelineDescriptor>;
}

interface CacheEntry<T> {
  key: string;
  descriptor: ModelPipelineDescriptor;
  state: ModelCacheEntryStatus['state'];
  references: number;
  updatedAt: number;
  lastUsedAt: number;
  expiresAt: number;
  promise: Promise<T>;
  value?: T;
  dispose: (value: T) => void | Promise<void>;
}

export interface ModelPipelineLease<T> {
  readonly value: T;
  updateDescriptor(descriptor: Partial<ModelPipelineDescriptor>): void;
  invalidate(): void;
  release(): Promise<void>;
}

/**
 * Bounded executable-model cache with load deduplication and lease-aware LRU.
 * The caller decides what persistent weight cache to use; this class owns only
 * executable pipelines/devices and never evicts one while a lease is active.
 */
export class ModelPipelineCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly options: {
      capacity?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  async acquire(
    key: string,
    descriptor: ModelPipelineDescriptor,
    load: () => Promise<LoadedModelPipeline<T>>,
    dispose: (value: T) => void | Promise<void>,
  ): Promise<ModelPipelineLease<T>> {
    let entry = this.entries.get(key);
    if (entry?.state === 'failed') {
      this.entries.delete(key);
      entry = undefined;
    }
    if (entry) return this.acquireEntry(entry);

    await this.evictExpired();
    entry = this.entries.get(key);
    if (entry) return this.acquireEntry(entry);
    const capacity = Math.max(1, Math.floor(this.options.capacity ?? DEFAULT_MODEL_PIPELINE_CACHE_CAPACITY));
    if (this.entries.size >= capacity) await this.makeRoom();
    entry = this.entries.get(key);
    if (entry) return this.acquireEntry(entry);
    const now = this.now();
    const created: CacheEntry<T> = {
      key,
      descriptor: { ...descriptor },
      state: 'loading',
      references: 1,
      updatedAt: now,
      lastUsedAt: now,
      expiresAt: now + this.ttlMs(),
      promise: Promise.resolve(undefined as T),
      dispose,
    };
    this.entries.set(key, created);
    created.promise = (async () => {
      try {
        const loaded = await load();
        created.value = loaded.value;
        created.descriptor = { ...created.descriptor, ...loaded.descriptor };
        if (created.state === 'loading') created.state = 'ready';
        created.updatedAt = this.now();
        created.expiresAt = this.now() + this.ttlMs();
        return loaded.value;
      } catch (error) {
        created.state = 'failed';
        created.updatedAt = this.now();
        created.expiresAt = this.now() + Math.min(this.ttlMs(), NODE_MODEL_CACHE_TTL_MS);
        throw error;
      }
    })();

    try {
      const value = await created.promise;
      return this.createLease(created, value);
    } catch (error) {
      created.references = Math.max(0, created.references - 1);
      throw error;
    }
  }

  private async acquireEntry(entry: CacheEntry<T>): Promise<ModelPipelineLease<T>> {
    if (entry.state === 'failed') {
      this.entries.delete(entry.key);
      throw new Error('model cache entry failed before it could be acquired');
    }
    if (entry.state === 'evicting') throw new Error('model cache entry is being evicted');
    entry.references++;
    entry.lastUsedAt = this.now();
    entry.expiresAt = this.now() + this.ttlMs();
    try {
      const value = await entry.promise;
      return this.createLease(entry, value);
    } catch (error) {
      entry.references = Math.max(0, entry.references - 1);
      throw error;
    }
  }

  getSnapshot(now = this.now()): NodeModelCacheSnapshot {
    return {
      version: 1,
      sampledAt: now,
      expiresAt: now + NODE_MODEL_CACHE_TTL_MS,
      entries: [...this.entries.values()].slice(0, 8).map((entry) => ({
        ...entry.descriptor,
        state: entry.state,
        referenceCount: entry.references,
      })),
    };
  }

  async releaseAll(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === 'failed') {
        this.entries.delete(entry.key);
        continue;
      }
      entry.state = 'evicting';
      entry.updatedAt = this.now();
      if (entry.references === 0 && entry.value !== undefined) pending.push(this.disposeEntry(entry));
    }
    await Promise.all(pending);
  }

  private createLease(entry: CacheEntry<T>, value: T): ModelPipelineLease<T> {
    let released = false;
    return {
      value,
      updateDescriptor: (descriptor) => {
        if (released) return;
        entry.descriptor = { ...entry.descriptor, ...descriptor };
        entry.updatedAt = this.now();
      },
      invalidate: () => {
        if (released) return;
        entry.state = 'evicting';
        entry.updatedAt = this.now();
      },
      release: async () => {
        if (released) return;
        released = true;
        entry.references = Math.max(0, entry.references - 1);
        entry.lastUsedAt = this.now();
        entry.updatedAt = this.now();
        if (entry.references === 0 && entry.state === 'evicting') {
          await this.disposeEntry(entry);
        } else if (entry.references === 0 && entry.state === 'ready') {
          entry.expiresAt = this.now() + this.ttlMs();
        }
      },
    };
  }

  private async evictExpired(): Promise<void> {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.state === 'failed' && entry.expiresAt <= now) this.entries.delete(entry.key);
      else if (entry.state === 'ready' && entry.references === 0 && entry.expiresAt <= now) {
        await this.disposeEntry(entry);
      }
    }
  }

  private async makeRoom(): Promise<void> {
    const capacity = Math.max(1, Math.floor(this.options.capacity ?? DEFAULT_MODEL_PIPELINE_CACHE_CAPACITY));
    while (this.entries.size >= capacity) {
      const candidates = [...this.entries.values()]
        .filter((entry) => entry.references === 0 && (entry.state === 'failed' || entry.state === 'ready'))
        .sort((left, right) => Number(right.state === 'failed') - Number(left.state === 'failed') || left.lastUsedAt - right.lastUsedAt);
      const candidate = candidates[0];
      if (!candidate) throw new Error('model cache capacity is occupied by active entries');
      if (candidate.state === 'failed') this.entries.delete(candidate.key);
      else await this.disposeEntry(candidate);
    }
  }

  private async disposeEntry(entry: CacheEntry<T>): Promise<void> {
    if (entry.references > 0 || entry.state === 'loading') return;
    entry.state = 'evicting';
    entry.updatedAt = this.now();
    const value = entry.value;
    entry.value = undefined;
    try {
      if (value !== undefined) await entry.dispose(value);
    } finally {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return Math.max(1, this.options.ttlMs ?? DEFAULT_MODEL_PIPELINE_TTL_MS);
  }
}

export function modelPipelineKey(identity: {
  task: string;
  modelId: string;
  revision: string;
  dtype: string;
  backend: ModelCacheBackend;
  layerRange?: [number, number];
}): string {
  return JSON.stringify([
    identity.task,
    identity.modelId,
    identity.revision,
    identity.dtype,
    identity.backend,
    identity.layerRange ?? null,
  ]);
}
