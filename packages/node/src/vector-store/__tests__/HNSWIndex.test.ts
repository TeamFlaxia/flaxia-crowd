import { describe, it, expect, vi } from 'vitest';
import {
  HNSWIndex,
  MAX_HNSW_LEVEL,
  MAX_HNSW_NODES,
  MAX_HNSW_NEIGHBORS_PER_LEVEL,
  type NodeExport,
} from '../HNSWIndex';

function vector(length: number, value = 0.1): Float32Array {
  return new Float32Array(length).fill(value);
}

function exportNode(id: number, level: number, neighbors: Record<number, number[]> = {}): NodeExport {
  return { id, docId: `doc-${id}`, level, neighbors };
}

describe('HNSWIndex distance validation (#18)', () => {
  it('rejects a query whose dimensions differ from the index', () => {
    const index = new HNSWIndex(4);
    index.insert('a', vector(4));

    expect(() => index.search(vector(3), 1)).toThrow(/dimension mismatch \(3 vs 4\)/);
    // A query longer than the stored vectors is just as invalid.
    expect(() => index.search(vector(5), 1)).toThrow(/dimension mismatch \(5 vs 4\)/);
  });

  it('rejects an insert whose vector does not match the index dimensions', () => {
    const index = new HNSWIndex(4);
    expect(() => index.insert('a', vector(3))).toThrow(/Float32Array of 4 dimensions/);
    expect(() => index.insert('a', [0.1, 0.2, 0.3, 0.4] as any)).toThrow(/Float32Array of 4 dimensions/);
  });

  it('never returns a NaN distance for a matching query', () => {
    // Keep the graph deterministic: every node lands on level 0, so the first
    // inserted node stays the entry point.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      const index = new HNSWIndex(4);
      // Orthogonal directions, so only 'a' is an exact cosine match: parallel
      // vectors all have distance 0 and the ordering would be meaningless.
      index.insert('a', Float32Array.from([1, 0, 0, 0]));
      index.insert('b', Float32Array.from([0, 1, 0, 0]));
      index.insert('c', Float32Array.from([0, 0, 1, 0]));

      // k >= node count so the search explores every neighbour (a k-limited walk
      // can legitimately stop at the entry point's neighbourhood).
      const results = index.search(Float32Array.from([1, 0, 0, 0]), 3);
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(Number.isFinite(result.distance)).toBe(true);
      }
      // The identical vector must score best and never come back as NaN.
      expect(results[0]!.docId).toBe('a');
      expect(results[0]!.distance).toBeCloseTo(0, 5);
    } finally {
      random.mockRestore();
    }
  });
});

describe('HNSWIndex importNodes validation (#18)', () => {
  const build = (nodes: NodeExport[], dims = 4) => {
    const vectors = new Map<number, Float32Array>();
    for (const node of nodes) vectors.set(node.id, vector(dims));
    return { nodes, vectors };
  };

  it('accepts a well-formed dump', () => {
    const index = new HNSWIndex(4);
    const { nodes, vectors } = build([
      exportNode(0, 1, { 0: [1], 1: [1] }),
      exportNode(1, 0, { 0: [0] }),
    ]);
    index.importNodes(nodes, vectors);
    expect(index.size()).toBe(2);
    expect(index.search(vector(4), 1)).toHaveLength(1);
  });

  it('rejects a level above MAX_HNSW_LEVEL', () => {
    const index = new HNSWIndex(4);
    const { nodes, vectors } = build([exportNode(0, MAX_HNSW_LEVEL + 1)]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/level .* outside 0\.\.16/);
  });

  it('rejects a negative or non-integer level', () => {
    const index = new HNSWIndex(4);
    for (const level of [-1, 1.5, Number.NaN, '2' as any]) {
      const { nodes, vectors } = build([exportNode(0, level as number)]);
      expect(() => index.importNodes(nodes, vectors)).toThrow(/level/);
    }
  });

  it('rejects adjacency that references a node which is not in the dump', () => {
    const index = new HNSWIndex(4);
    const { nodes, vectors } = build([exportNode(0, 0, { 0: [7] })]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/references unknown neighbor 7/);
  });

  it('rejects adjacency declared for a level above the node level', () => {
    const index = new HNSWIndex(4);
    const { nodes, vectors } = build([exportNode(0, 0, { 2: [] })]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/adjacency for level 2 above its level 0/);
  });

  it('rejects an oversized adjacency list', () => {
    const index = new HNSWIndex(4);
    const neighbors = new Array(MAX_HNSW_NEIGHBORS_PER_LEVEL + 1).fill(0);
    const { nodes, vectors } = build([exportNode(0, 0, { 0: neighbors })]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/above the 1024 limit/);
  });

  it('rejects duplicate ids and malformed ids', () => {
    const index = new HNSWIndex(4);
    const { nodes, vectors } = build([exportNode(0, 0), exportNode(0, 0)]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/duplicate node id 0/);

    const bad = build([exportNode(1.5, 0)]);
    expect(() => index.importNodes(bad.nodes, bad.vectors)).toThrow(/non-negative integer/);
  });

  it('rejects a missing vector', () => {
    const index = new HNSWIndex(4);
    expect(() => index.importNodes([exportNode(0, 0)], new Map())).toThrow(/has no vector/);
  });

  it('rejects a vector with the wrong dimensions', () => {
    const index = new HNSWIndex(4);
    const nodes = [exportNode(0, 0)];
    const vectors = new Map([[0, vector(3)]]);
    expect(() => index.importNodes(nodes, vectors)).toThrow(/Float32Array of 4 dimensions/);
  });

  it('rejects a non-finite vector element', () => {
    const index = new HNSWIndex(4);
    const nodes = [exportNode(0, 0)];
    const poisoned = vector(4);
    poisoned[2] = Number.NaN;
    expect(() => index.importNodes(nodes, new Map([[0, poisoned]]))).toThrow(/non-finite value at 2/);

    const infinite = vector(4);
    infinite[0] = Number.POSITIVE_INFINITY;
    expect(() => index.importNodes(nodes, new Map([[0, infinite]]))).toThrow(/non-finite value at 0/);
  });

  it('rejects a dump above the node quota', () => {
    const index = new HNSWIndex(4);
    const nodes: NodeExport[] = [];
    const vectors = new Map<number, Float32Array>();
    for (let i = 0; i <= MAX_HNSW_NODES; i++) {
      nodes.push(exportNode(i, 0));
      vectors.set(i, vector(4));
    }
    expect(() => index.importNodes(nodes, vectors)).toThrow(new RegExp(`exceed the ${MAX_HNSW_NODES} quota`));
  });

  it('exposes a bounded node quota', () => {
    expect(MAX_HNSW_NODES).toBe(100_000);
  });
});