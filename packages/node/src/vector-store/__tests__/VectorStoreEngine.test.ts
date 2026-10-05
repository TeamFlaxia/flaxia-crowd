import { describe, it, expect, vi } from 'vitest';
import {
  MAX_QUERY_TOP_K,
  MAX_STORED_VECTORS,
  MAX_VECTOR_DIMENSIONS,
  VectorStoreEngine,
  assertShardKey,
  assertVectorShape,
} from '../VectorStoreEngine';
import { HNSWIndex } from '../HNSWIndex';

describe('vector shape validation (#18)', () => {
  it('rejects the {length: 2**30} array-like before allocating', () => {
    // This is the PoC from issue #18: `new Float32Array({length: 2**30})` would
    // attempt a 4 GiB allocation before any dimension check.
    const arrayLike = { length: 2 ** 30 };
    expect(() => assertVectorShape(arrayLike, 'vector')).toThrow(/must be an array of numbers/);
  });

  it('rejects non-array and array-like values', () => {
    for (const value of [null, undefined, 42, 'abcd', { 0: 1, length: 1 }, new Float32Array(4)]) {
      expect(() => assertVectorShape(value, 'vector')).toThrow(/must be an array of numbers/);
    }
  });

  it('rejects invalid lengths', () => {
    expect(() => assertVectorShape([], 'vector')).toThrow(/positive integer/);
    expect(() => assertVectorShape({ length: -1 }, 'vector')).toThrow(/must be an array/);
    // A sparse array with a huge declared length is caught by the limit.
    const sparse = new Array(MAX_VECTOR_DIMENSIONS + 1);
    expect(() => assertVectorShape(sparse, 'vector')).toThrow(/above the 4096 limit/);
  });

  it('rejects a length above the element cap', () => {
    expect(() => assertVectorShape(new Array(MAX_VECTOR_DIMENSIONS).fill(0), 'vector', MAX_VECTOR_DIMENSIONS, 10)).toThrow(
      /above the 10 limit/,
    );
  });

  it('rejects non-finite and non-numeric elements', () => {
    expect(() => assertVectorShape([0.1, Number.NaN], 'vector')).toThrow(/\[1\] must be a finite number/);
    expect(() => assertVectorShape([0.1, Number.POSITIVE_INFINITY], 'vector')).toThrow(/\[1\] must be a finite number/);
    expect(() => assertVectorShape([0.1, '0.2'], 'vector')).toThrow(/\[1\] must be a finite number/);
  });

  it('accepts a bounded finite vector', () => {
    expect(assertVectorShape([0.1, 0.2, 0.3], 'vector')).toBe(3);
    expect(MAX_VECTOR_DIMENSIONS).toBe(4096);
  });
});

describe('shardKey validation (#18)', () => {
  it("rejects 'not-a-number' instead of passing the shard gate", () => {
    // parseInt('not-a-number') is NaN, and NaN < start / NaN > end are both
    // false, so the old range check let this through.
    expect(() => assertShardKey('not-a-number', 0, 100)).toThrow(/must be an integer/);
  });

  it('rejects NaN, floats and non-scalar values', () => {
    expect(() => assertShardKey(Number.NaN, 0, 100)).toThrow(/must be an integer/);
    expect(() => assertShardKey(1.5, 0, 100)).toThrow(/must be an integer/);
    expect(() => assertShardKey({}, 0, 100)).toThrow(/must be a string or number/);
    expect(() => assertShardKey('12abc', 0, 100)).toThrow(/must be an integer/);
  });

  it('accepts integer strings and enforces the shard range', () => {
    expect(assertShardKey('42', 0, 100)).toBe(42);
    expect(assertShardKey(42, 0, 100)).toBe(42);
    expect(() => assertShardKey(101, 0, 100)).toThrow(/out of range/);
    expect(() => assertShardKey(-1, 0, 100)).toThrow(/out of range/);
  });
});

describe('VectorStoreEngine gates before touching IndexedDB (#18)', () => {
  /** An engine with no database: every path below must throw before using it. */
  function engineWithShard(dimensions = 4): VectorStoreEngine {
    const engine = new VectorStoreEngine();
    (engine as any).shardInfo = { rangeStart: 0, rangeEnd: 1000 };
    (engine as any).hnsw = new HNSWIndex(dimensions);
    return engine;
  }

  const basePayload = {
    docId: 'doc-1',
    metadata: { title: 't', url: 'u', snippet: 's' },
    shardKey: '1',
  };

  it('rejects a 4 GiB array-like vector without allocating', async () => {
    const engine = engineWithShard();
    await expect(
      engine.store({ ...basePayload, vector: { length: 2 ** 30 } as any }),
    ).rejects.toThrow(/must be an array of numbers/);
  });

  it('rejects a non-integer shardKey before storing', async () => {
    const engine = engineWithShard();
    await expect(
      engine.store({ ...basePayload, shardKey: 'not-a-number', vector: [0.1, 0.2, 0.3, 0.4] }),
    ).rejects.toThrow(/must be an integer/);
  });

  it('rejects a vector with the wrong dimensions before storing', async () => {
    const engine = engineWithShard(4);
    await expect(
      engine.store({ ...basePayload, vector: [0.1, 0.2, 0.3] }),
    ).rejects.toThrow(/vector has 3 dimensions but this index stores 4/);
  });

  it('rejects a query vector with the wrong dimensions before searching', async () => {
    const engine = engineWithShard(4);
    await expect(engine.query({ queryVector: [0.1, 0.2], topK: 1 })).rejects.toThrow(
      /queryVector has 2 dimensions but this index stores 4/,
    );
  });

  it('rejects an array-like query vector', async () => {
    const engine = engineWithShard(4);
    await expect(engine.query({ queryVector: { length: 2 ** 30 } as any, topK: 1 })).rejects.toThrow(
      /must be an array of numbers/,
    );
  });

  it('rejects an out-of-range topK', async () => {
    const engine = engineWithShard(4);
    for (const topK of [0, -1, 1.5, MAX_QUERY_TOP_K + 1]) {
      await expect(engine.query({ queryVector: [0.1, 0.2, 0.3, 0.4], topK })).rejects.toThrow(/topK must be an integer/);
    }
  });

  it('rejects a store once the persisted-node quota is reached', async () => {
    const engine = engineWithShard(4);
    const hnsw = (engine as any).hnsw as HNSWIndex;
    // Simulate a full index without allocating 100k nodes.
    vi.spyOn(hnsw, 'size').mockReturnValue(MAX_STORED_VECTORS);

    await expect(
      engine.store({ ...basePayload, vector: [0.1, 0.2, 0.3, 0.4] }),
    ).rejects.toThrow(/storage quota reached/);
  });
});