import type { VectorStorePayload, VectorStoreResult, VectorQueryPayload, VectorQueryResult } from '@flaxia/sdk';
import { HNSWIndex, MAX_HNSW_NODES, type NodeExport } from './HNSWIndex';

/**
 * Vector shape limits.
 *
 * `payload.vector` / `payload.queryVector` are typed as `number[]` but arrive
 * from the network as arbitrary JSON: a plain array-like such as
 * `{ length: 2 ** 30 }` would otherwise make `new Float32Array(value)` attempt a
 * ~4 GiB allocation *before* any dimension check. Every value is therefore
 * validated as a real, bounded array first.
 */
export const MAX_VECTOR_DIMENSIONS = 4096;
/** Upper bound for the total number of elements in one request. */
export const MAX_VECTOR_ELEMENTS = 1_048_576;
/** Upper bound for the number of vectors persisted on this node. */
export const MAX_STORED_VECTORS = MAX_HNSW_NODES;
/** Largest accepted `topK` for a query. */
export const MAX_QUERY_TOP_K = 1000;

/**
 * Validate a vector-ish value and return its length without allocating.
 *
 * Rejects: non-arrays, array-likes (`{length: n}`), `arguments`-style objects,
 * non-integer/negative/NaN lengths, lengths above `maxDimensions` and element
 * counts above `maxElements`.
 */
export function assertVectorShape(
  value: unknown,
  name: string,
  maxDimensions = MAX_VECTOR_DIMENSIONS,
  maxElements = MAX_VECTOR_ELEMENTS,
): number {
  if (!Array.isArray(value)) {
    throw new Error(`vector-store: ${name} must be an array of numbers`);
  }
  const length = value.length;
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`vector-store: ${name} length must be a positive integer, got ${String(length)}`);
  }
  if (length > maxDimensions) {
    throw new Error(`vector-store: ${name} has ${length} dimensions, above the ${maxDimensions} limit`);
  }
  if (length > maxElements) {
    throw new Error(`vector-store: ${name} has ${length} elements, above the ${maxElements} limit`);
  }
  for (let i = 0; i < length; i++) {
    const element = value[i];
    if (typeof element !== 'number' || !Number.isFinite(element)) {
      throw new Error(`vector-store: ${name}[${i}] must be a finite number`);
    }
  }
  return length;
}

/**
 * Validate a shard key with `Number.isInteger`. `parseInt('not-a-number')` is
 * `NaN`, and both `NaN < start` and `NaN > end` are false, so the old check let
 * non-numeric keys through the shard gate.
 */
export function assertShardKey(value: unknown, rangeStart: number, rangeEnd: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`vector-store: shardKey must be a string or number, got ${typeof value}`);
  }
  const shardKey = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(shardKey)) {
    throw new Error(`vector-store: shardKey must be an integer, got ${JSON.stringify(value)}`);
  }
  if (shardKey < rangeStart || shardKey > rangeEnd) {
    throw new Error(`Shard key ${shardKey} out of range`);
  }
  return shardKey;
}

function openDB(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getStore(db: IDBDatabase, name: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

function getRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = getStore(db, storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function putRecord(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = getStore(db, storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function getAllRecords<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = getStore(db, storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

interface ShardInfo {
  key: string;
  rangeStart: number;
  rangeEnd: number;
  nodeId: string;
  assignedAt: number;
}

interface VectorRecord {
  docId: string;
  vector: Float32Array;
  metadata: { title: string; url: string; snippet: string; [key: string]: unknown };
  shardKey: string;
  storedAt: number;
}

interface HNSWGraphRecord {
  nodeId: number;
  docId: string;
  level: number;
  neighbors: Record<number, number[]>;
}

export class VectorStoreEngine {
  private db: IDBDatabase | null = null;
  private hnsw: HNSWIndex | null = null;
  private shardInfo: { rangeStart: number; rangeEnd: number } | null = null;
  private saveCounter = 0;

  async initialize(): Promise<void> {
    this.db = await openDB('flaxia-vector-store', 1, (db) => {
      if (!db.objectStoreNames.contains('vectors')) {
        db.createObjectStore('vectors', { keyPath: 'docId' });
      }
      if (!db.objectStoreNames.contains('hnsw-graph')) {
        db.createObjectStore('hnsw-graph', { keyPath: 'nodeId' });
      }
      if (!db.objectStoreNames.contains('shard-info')) {
        db.createObjectStore('shard-info', { keyPath: 'key' });
      }
    });

    this.hnsw = new HNSWIndex(1024, 'cosine', 16, 200);
    await this.loadGraphFromDB();

    const shardInfo = await getRecord<ShardInfo>(this.db, 'shard-info', 'shard_range');
    if (shardInfo) {
      this.shardInfo = { rangeStart: shardInfo.rangeStart, rangeEnd: shardInfo.rangeEnd };
    }
  }

  async assignShard(rangeStart: number, rangeEnd: number): Promise<void> {
    this.shardInfo = { rangeStart, rangeEnd };
    await putRecord(this.db!, 'shard-info', {
      key: 'shard_range',
      rangeStart,
      rangeEnd,
      nodeId: '',
      assignedAt: Date.now(),
    });
  }

  async store(payload: VectorStorePayload): Promise<VectorStoreResult> {
    if (!this.shardInfo) throw new Error('No shard assigned');

    const shardKey = assertShardKey(payload.shardKey, this.shardInfo.rangeStart, this.shardInfo.rangeEnd);

    // Validate the shape before any typed-array construction or IDB write.
    const dimensions = assertVectorShape(payload.vector, 'vector');
    if (this.hnsw && dimensions !== this.hnsw.dimensionsValue) {
      throw new Error(
        `vector-store: vector has ${dimensions} dimensions but this index stores ${this.hnsw.dimensionsValue}`,
      );
    }
    if (this.hnsw && this.hnsw.size() >= MAX_STORED_VECTORS) {
      throw new Error(
        `vector-store: node storage quota reached (${MAX_STORED_VECTORS} vectors); refusing to store more`,
      );
    }
    const vector = new Float32Array(payload.vector);

    await putRecord(this.db!, 'vectors', {
      docId: payload.docId,
      vector,
      metadata: payload.metadata,
      shardKey: String(shardKey),
      storedAt: Date.now(),
    });

    this.hnsw!.insert(payload.docId, vector);
    this.saveCounter++;
    if (this.saveCounter % 100 === 0) {
      await this.saveGraphSnapshot();
    }

    return {
      stored: true,
      nodeId: '',
      totalVectors: this.hnsw!.size(),
    };
  }

  async query(payload: VectorQueryPayload): Promise<VectorQueryResult> {
    if (!this.hnsw) throw new Error('HNSW not initialized');

    const dimensions = assertVectorShape(payload.queryVector, 'queryVector');
    if (dimensions !== this.hnsw.dimensionsValue) {
      throw new Error(
        `vector-store: queryVector has ${dimensions} dimensions but this index stores ${this.hnsw.dimensionsValue}`,
      );
    }
    const topK = payload.topK;
    if (!Number.isInteger(topK) || topK <= 0 || topK > MAX_QUERY_TOP_K) {
      throw new Error(`vector-store: topK must be an integer within 1..${MAX_QUERY_TOP_K}, got ${JSON.stringify(topK)}`);
    }

    const startTime = performance.now();
    const queryVec = new Float32Array(payload.queryVector);
    const neighbors = this.hnsw.search(queryVec, topK);

    const results = neighbors.map(n => ({
      docId: n.docId,
      score: 1 - n.distance,
      metadata: n.metadata as { title: string; url: string; snippet: string } || { title: '', url: '', snippet: '' },
    }));

    return {
      results,
      nodeId: '',
      searchDurationMs: Math.round(performance.now() - startTime),
    };
  }

  async getVector(docId: string): Promise<VectorRecord | undefined> {
    return getRecord<VectorRecord>(this.db!, 'vectors', docId);
  }

  async deleteVector(docId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = getStore(this.db!, 'vectors', 'readwrite').delete(docId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  getVectorCount(): number {
    return this.hnsw?.size() || 0;
  }

  /**
   * Rebuild the in-memory graph from IndexedDB.
   *
   * The records are same-origin writable storage, so they are treated as
   * untrusted: `importNodes` re-validates levels, adjacency and vector
   * dimensions and throws on a corrupted graph instead of silently building an
   * index that later produces NaN distances.
   *
   * Residual risk (documented, accepted for this workload): the persisted
   * vectors and metadata are stored in plaintext in IndexedDB, so any script on
   * the same origin can read them. They are node-local working data for the
   * customer's own task, and the quota above bounds how much can be stored.
   */
  private async loadGraphFromDB(): Promise<void> {
    const records = await getAllRecords<HNSWGraphRecord>(this.db!, 'hnsw-graph');
    if (records.length === 0) return;

    if (records.length > MAX_STORED_VECTORS) {
      throw new Error(
        `vector-store: persisted graph holds ${records.length} nodes, above the ${MAX_STORED_VECTORS} quota`,
      );
    }

    const vectors = new Map<number, Float32Array>();
    const nodeExports: NodeExport[] = [];
    for (const rec of records) {
      const vecRecord = await getRecord<VectorRecord>(this.db!, 'vectors', rec.docId);
      if (vecRecord && vecRecord.vector) {
        vectors.set(rec.nodeId, vecRecord.vector instanceof Float32Array
          ? vecRecord.vector
          : new Float32Array(vecRecord.vector));
      }
      nodeExports.push({
        id: rec.nodeId,
        docId: rec.docId,
        level: rec.level,
        neighbors: rec.neighbors,
      });
    }

    this.hnsw!.importNodes(nodeExports, vectors);
  }

  private async saveGraphSnapshot(): Promise<void> {
    const nodes = this.hnsw!.exportNodes();
    for (const [nodeId, data] of nodes) {
      await putRecord(this.db!, 'hnsw-graph', {
        nodeId,
        docId: data.docId,
        level: data.level,
        neighbors: data.neighbors,
      });
    }
  }
}
