/**
 * Pinned model download for the FriedFlaxia backends.
 *
 * Unlike `ai-inference` payloads, these URLs never come from a task. They are
 * compile-time constants mirrored from the Rust crate's `model-manifest.json`
 * by `scripts/sync-friedflaxia.mjs`, and the node only accepts the exact
 * SHA-256 listed there.
 *
 * Verified downloads are also persisted under that digest. The digest is an
 * immutable identity for a pin, so a cache entry can be trusted (after a fresh
 * hash check) even if the URL changes or the executable model was evicted from
 * memory. Storage is best-effort: a broken or unavailable cache never prevents
 * a download, and a corrupt cache entry is discarded and re-fetched.
 */
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharedManifest from '../../vendor/friedflaxia/model-manifest.json';

const models = sharedManifest.models;

export const FRIEDFLAXIA_EMBED_GEMMA = models.embeddingGemma;
export const FRIEDFLAXIA_EMBED_GEMMA_MMPROJ = models.embeddingGemmaMmproj;
export const FRIEDFLAXIA_PLAMO = models.plamo;
export const FRIEDFLAXIA_D1 = models.d1;
export const FRIEDFLAXIA_D1_MMPROJ = models.d1Mmproj;
export const FRIEDFLAXIA_NUDENET = models.nudenet;
export const FRIEDFLAXIA_DLLM = models.dllm;

export interface PinnedModel {
  url: string;
  sha256: string;
  maxBytes: number;
}

/** Minimal storage contract shared by the filesystem and browser backends. */
export interface ModelCache {
  /** Return a cached entry only when it is present and within `maxBytes`. */
  read(sha256: string, maxBytes: number): Promise<Uint8Array | undefined>;
  write(sha256: string, bytes: Uint8Array): Promise<void>;
  remove(sha256: string): Promise<void>;
  clear(): Promise<void>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CACHE_DIR_NAME = 'flaxia-models';
const CACHE_DIR_ENV = 'FLAXIA_MODEL_CACHE_DIR';
const CACHE_STORAGE_NAME = 'flaxia-models-v1';
const INDEXED_DB_NAME = 'flaxia-models';
const INDEXED_DB_STORE = 'weights';

/** Reject an oversized response before materializing its body. */
export function assertModelSize(
  byteLength: number,
  maxBytes: number = FRIEDFLAXIA_EMBED_GEMMA.maxBytes,
): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error('friedflaxia: model response has no usable Content-Length');
  }
  if (byteLength > maxBytes) {
    throw new Error(
      `friedflaxia: model file too large (${byteLength} > ${maxBytes})`,
    );
  }
}

/** Lowercase hex SHA-256 of the model bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // WebCrypto accepts any ArrayBufferView; the cast only narrows TypeScript's
  // ArrayBufferLike (which also covers SharedArrayBuffer) to its BufferSource.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a pin's digest before using it as a storage key. Without this a
 * malformed pin could escape the cache directory (or poison a browser key).
 */
function normalizeSha256(sha256: string): string {
  const key = typeof sha256 === 'string' ? sha256.toLowerCase() : '';
  if (!SHA256_PATTERN.test(key)) {
    throw new Error('friedflaxia: model sha256 must be a 64-character hex digest');
  }
  return key;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

/** Node filesystem cache: `<FLAXIA_MODEL_CACHE_DIR or os.tmpdir()>/flaxia-models/<sha256>.bin`. */
function createNodeCache(): ModelCache {
  const root = (): string => {
    const configured =
      typeof process !== 'undefined' ? process.env?.[CACHE_DIR_ENV] : undefined;
    return configured ? configured : tmpdir();
  };
  const pathFor = (sha256: string): string =>
    join(root(), CACHE_DIR_NAME, `${sha256}.bin`);

  return {
    async read(sha256, maxBytes) {
      const path = pathFor(sha256);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > maxBytes) return undefined;
        const bytes = new Uint8Array(await readFile(path));
        return bytes.byteLength <= maxBytes ? bytes : undefined;
      } catch {
        // A missing or unreadable cache entry is simply a cache miss.
        return undefined;
      }
    },
    async write(sha256, bytes) {
      const directory = join(root(), CACHE_DIR_NAME);
      await mkdir(directory, { recursive: true });
      const temporary = join(
        directory,
        `.${sha256}.${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}.tmp`,
      );
      try {
        await writeFile(temporary, bytes);
        // Rename is atomic on the same filesystem: readers never see a partial
        // file, even if two downloads race for the same digest.
        await rename(temporary, pathFor(sha256));
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    },
    async remove(sha256) {
      try {
        await unlink(pathFor(sha256));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
    async clear() {
      await rm(join(root(), CACHE_DIR_NAME), { recursive: true, force: true });
    },
  };
}

/** Browser Cache Storage backend (preferred when available). */
function createCacheStorageCache(storage: CacheStorage): ModelCache {
  const keyFor = (sha256: string): string => {
    const origin =
      typeof globalThis.location?.href === 'string'
        ? globalThis.location.origin
        : 'https://flaxia.invalid';
    return `${origin}/__flaxia_models/${sha256}.bin`;
  };

  return {
    async read(sha256, maxBytes) {
      try {
        const cache = await storage.open(CACHE_STORAGE_NAME);
        const key = keyFor(sha256);
        const response = await cache.match(key);
        if (!response || !response.ok) return undefined;
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > 0 && declared > maxBytes) {
          await cache.delete(key).catch(() => {});
          return undefined;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return bytes.byteLength <= maxBytes ? bytes : undefined;
      } catch {
        return undefined;
      }
    },
    async write(sha256, bytes) {
      const cache = await storage.open(CACHE_STORAGE_NAME);
      await cache.put(
        keyFor(sha256),
        new Response(bytes as unknown as BodyInit, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );
    },
    async remove(sha256) {
      try {
        const cache = await storage.open(CACHE_STORAGE_NAME);
        await cache.delete(keyFor(sha256));
      } catch {
        // Best effort.
      }
    },
    async clear() {
      await storage.delete(CACHE_STORAGE_NAME);
    },
  };
}

/** Browser IndexedDB backend, used when Cache Storage is unavailable. */
function createIndexedDbCache(indexedDb: IDBFactory): ModelCache {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDb.open(INDEXED_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(INDEXED_DB_STORE)) {
          database.createObjectStore(INDEXED_DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('friedflaxia: model cache open blocked'));
    });

  const readRequest = <T>(use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    open().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const transaction = database.transaction(INDEXED_DB_STORE, 'readonly');
          const request = use(transaction.objectStore(INDEXED_DB_STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
          transaction.oncomplete = () => database.close();
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        }),
    );

  const writeTransaction = (use: (store: IDBObjectStore) => void): Promise<void> =>
    open().then(
      (database) =>
        new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(INDEXED_DB_STORE, 'readwrite');
          use(transaction.objectStore(INDEXED_DB_STORE));
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
          transaction.onabort = () => {
            database.close();
            reject(transaction.error);
          };
        }),
    );

  return {
    async read(sha256, maxBytes) {
      try {
        const value = await readRequest<Uint8Array>((store) => store.get(sha256));
        if (!(value instanceof Uint8Array) || value.byteLength > maxBytes) return undefined;
        return value;
      } catch {
        return undefined;
      }
    },
    async write(sha256, bytes) {
      await writeTransaction((store) => store.put(new Uint8Array(bytes), sha256));
    },
    async remove(sha256) {
      try {
        await writeTransaction((store) => store.delete(sha256));
      } catch {
        // Best effort.
      }
    },
    async clear() {
      await writeTransaction((store) => store.clear());
    },
  };
}

/** Last-resort browser cache when neither Cache Storage nor IndexedDB exists. */
function createMemoryCache(): ModelCache {
  const entries = new Map<string, Uint8Array>();
  return {
    async read(sha256, maxBytes) {
      const bytes = entries.get(sha256);
      return bytes && bytes.byteLength <= maxBytes ? bytes : undefined;
    },
    async write(sha256, bytes) {
      entries.set(sha256, new Uint8Array(bytes));
    },
    async remove(sha256) {
      entries.delete(sha256);
    },
    async clear() {
      entries.clear();
    },
  };
}

type BackendKind = 'node' | 'cache-storage' | 'indexed-db' | 'memory';

/**
 * Runtime detection stays synchronous and uses only global feature probes:
 * bundlers can keep `node:*` imports external for browser targets without
 * introducing a dynamic import that would split (or break) the bundle.
 */
function detectBackend(): BackendKind {
  if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') {
    return 'node';
  }
  const host = globalThis as {
    caches?: CacheStorage;
    indexedDB?: IDBFactory;
  };
  if (typeof host.caches?.open === 'function' && typeof host.caches?.delete === 'function') {
    return 'cache-storage';
  }
  if (host.indexedDB) return 'indexed-db';
  return 'memory';
}

let activeBackend: { kind: BackendKind; cache: ModelCache } | undefined;

function currentCache(): ModelCache {
  const kind = detectBackend();
  if (activeBackend?.kind !== kind) {
    const host = globalThis as { caches?: CacheStorage; indexedDB?: IDBFactory };
    const cache =
      kind === 'node'
        ? createNodeCache()
        : kind === 'cache-storage' && host.caches
          ? createCacheStorageCache(host.caches)
          : kind === 'indexed-db' && host.indexedDB
            ? createIndexedDbCache(host.indexedDB)
            : createMemoryCache();
    activeBackend = { kind, cache };
  }
  return activeBackend.cache;
}

/** Remove every pinned-model cache entry for the current runtime. */
export async function clearModelCache(): Promise<void> {
  await currentCache().clear();
}

/** Remove one cached pin by its SHA-256 (invalid digests are rejected). */
export async function removeCachedModel(sha256: string): Promise<void> {
  const key = normalizeSha256(sha256);
  await currentCache().remove(key);
}

/** Downloads sharing a digest while one is in flight share the same request. */
const inFlight = new Map<string, Promise<Uint8Array>>();

/** Download, verify and cache one pinned model file. */
export async function downloadPinnedModel(model: PinnedModel): Promise<Uint8Array> {
  const key = normalizeSha256(model.sha256);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = downloadAndCache(model, key).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function downloadAndCache(model: PinnedModel, key: string): Promise<Uint8Array> {
  const cache = currentCache();
  let cached: Uint8Array | undefined;
  try {
    cached = await cache.read(key, model.maxBytes);
  } catch {
    cached = undefined;
  }
  if (cached) {
    const digest = await sha256Hex(cached);
    if (digest === key) return cached;
    // Tampered or stale entry: drop it before falling back to the network.
    await cache.remove(key).catch(() => {});
  }

  const response = await fetch(model.url, {
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`friedflaxia: model download failed (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0) {
    assertModelSize(declared, model.maxBytes);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertModelSize(bytes.byteLength, model.maxBytes);
  const digest = await sha256Hex(bytes);
  if (digest !== key) {
    throw new Error(`friedflaxia: model SHA-256 mismatch (${digest})`);
  }

  // Persistence is an optimization only: never fail a verified download
  // because the cache is full, read-only or otherwise unavailable.
  await cache.write(key, bytes).catch(() => {});
  return bytes;
}
