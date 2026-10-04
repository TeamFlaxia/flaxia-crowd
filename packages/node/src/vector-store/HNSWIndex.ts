interface HNSWNode {
  id: number;
  docId: string;
  vector: Float32Array;
  level: number;
  neighbors: Map<number, number[]>;
}

interface Candidate {
  nodeId: number;
  distance: number;
}

export interface SearchResult {
  docId: string;
  distance: number;
  metadata?: Record<string, unknown>;
}

export interface NodeExport {
  id: number;
  docId: string;
  level: number;
  neighbors: Record<number, number[]>;
}

/**
 * Storage/robustness limits for a node's index.
 *
 * - `MAX_HNSW_NODES` bounds how many vectors a volunteer node persists (the
 *   IndexedDB graph is writable by any same-origin script, so a corrupted or
 *   hostile dump must not be able to grow the in-memory graph without limit).
 * - `MAX_HNSW_LEVEL` matches `randomLevel()`; an imported level above it would
 *   otherwise be used to index `neighbors` maps that were never created.
 * - `MAX_HNSW_NEIGHBORS_PER_LEVEL` bounds adjacency lists read back from disk.
 */
export const MAX_HNSW_NODES = 100_000;
export const MAX_HNSW_LEVEL = 16;
export const MAX_HNSW_NEIGHBORS_PER_LEVEL = 1024;

export class HNSWIndex {
  private nodes: Map<number, HNSWNode> = new Map();
  private docIdMap: Map<string, number> = new Map();
  private enterPoint: number | null = null;
  private nextNodeId = 0;
  private maxLevel = 0;

  constructor(
    private dimensions: number,
    private metric: 'cosine' | 'l2' = 'cosine',
    private M: number = 16,
    private efConstruction: number = 200,
  ) {}

  /** Vector width this index was built for. */
  get dimensionsValue(): number {
    return this.dimensions;
  }

  insert(docId: string, vector: Float32Array): void {
    if (this.nodes.size >= MAX_HNSW_NODES) {
      throw new Error(`HNSW index is full (${MAX_HNSW_NODES} nodes); refusing to insert more`);
    }
    if (!(vector instanceof Float32Array) || vector.length !== this.dimensions) {
      throw new Error(
        `HNSW insert: vector must be a Float32Array of ${this.dimensions} dimensions, got ${vector?.length ?? 'none'}`,
      );
    }

    const nodeId = this.nextNodeId++;
    const level = this.randomLevel();
    const node: HNSWNode = {
      id: nodeId,
      docId,
      vector,
      level,
      neighbors: new Map(),
    };

    this.nodes.set(nodeId, node);
    this.docIdMap.set(docId, nodeId);

    if (this.enterPoint === null) {
      this.enterPoint = nodeId;
      this.maxLevel = level;
      return;
    }

    let currNode = this.nodes.get(this.enterPoint)!;
    let currDist = this.distance(vector, currNode.vector);

    for (let l = this.maxLevel; l > level; l--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = currNode.neighbors.get(l) || [];
        for (const nId of neighbors) {
          const nNode = this.nodes.get(nId);
          if (!nNode) continue;
          const d = this.distance(vector, nNode.vector);
          if (d < currDist) {
            currDist = d;
            currNode = nNode;
            changed = true;
          }
        }
      }
    }

    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const candidates = this.searchLayer(vector, currNode, l, this.efConstruction);
      const selected = this.selectNeighbors(candidates, this.M);

      const neighbors = currNode.neighbors.get(l) || [];
      for (const s of selected) {
        if (!neighbors.includes(s.nodeId)) {
          neighbors.push(s.nodeId);
        }
      }
      currNode.neighbors.set(l, neighbors);

      for (const s of selected) {
        const sNode = this.nodes.get(s.nodeId);
        if (sNode) {
          const sNeighbors = sNode.neighbors.get(l) || [];
          if (!sNeighbors.includes(nodeId)) {
            sNeighbors.push(nodeId);
          }
          sNode.neighbors.set(l, sNeighbors.slice(-this.M));
        }
      }
    }

    if (level > this.maxLevel) {
      this.enterPoint = nodeId;
      this.maxLevel = level;
    }
  }

  search(query: Float32Array, k: number): SearchResult[] {
    if (this.nodes.size === 0 || this.enterPoint === null) return [];

    let currNode = this.nodes.get(this.enterPoint)!;
    let currDist = this.distance(query, currNode.vector);

    for (let l = this.maxLevel; l > 0; l--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = currNode.neighbors.get(l) || [];
        for (const nId of neighbors) {
          const nNode = this.nodes.get(nId);
          if (!nNode) continue;
          const d = this.distance(query, nNode.vector);
          if (d < currDist) {
            currDist = d;
            currNode = nNode;
            changed = true;
          }
        }
      }
    }

    const candidates = this.searchLayer(query, currNode, 0, k);
    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k)
      .map(c => ({
        docId: this.nodes.get(c.nodeId)!.docId,
        distance: c.distance,
        metadata: {},
      }));
  }

  private searchLayer(
    query: Float32Array,
    entry: HNSWNode,
    level: number,
    ef: number,
  ): Candidate[] {
    const visited = new Set<number>([entry.id]);
    const candidates: Candidate[] = [{ nodeId: entry.id, distance: this.distance(query, entry.vector) }];
    const result: Candidate[] = [...candidates];
    const distMap = new Map<number, number>();
    distMap.set(entry.id, candidates[0].distance);

    while (candidates.length > 0) {
      let nearestIdx = 0;
      for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].distance < candidates[nearestIdx].distance) {
          nearestIdx = i;
        }
      }
      const nearest = candidates[nearestIdx];

      const farthestDist = result.length > 0
        ? Math.max(...result.map(r => r.distance))
        : Infinity;

      if (nearest.distance > farthestDist && result.length >= ef) break;

      candidates.splice(nearestIdx, 1);
      const node = this.nodes.get(nearest.nodeId);
      if (!node) continue;

      const neighbors = node.neighbors.get(level) || [];
      for (const nId of neighbors) {
        if (visited.has(nId)) continue;
        visited.add(nId);
        const nNode = this.nodes.get(nId);
        if (!nNode) continue;
        const d = this.distance(query, nNode.vector);
        distMap.set(nId, d);

        const farthestInResult = result.length > 0
          ? Math.max(...result.map(r => r.distance))
          : Infinity;

        if (result.length < ef || d < farthestInResult) {
          candidates.push({ nodeId: nId, distance: d });
          result.push({ nodeId: nId, distance: d });

          if (result.length > ef) {
            result.sort((a, b) => b.distance - a.distance);
            result.pop();
          }
        }
      }
    }

    result.sort((a, b) => a.distance - b.distance);
    return result.slice(0, ef);
  }

  private selectNeighbors(candidates: Candidate[], M: number): Candidate[] {
    return candidates.sort((a, b) => a.distance - b.distance).slice(0, M);
  }

  /**
   * Distance between two vectors. Dimensions must match: iterating `a.length`
   * over a shorter `b` used to return `NaN` (or a silently truncated score),
   * which corrupted search results instead of failing.
   */
  private distance(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`HNSW distance: dimension mismatch (${a.length} vs ${b.length})`);
    }
    if (this.metric === 'cosine') {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      const denom = Math.sqrt(na) * Math.sqrt(nb);
      return denom === 0 ? 1 : 1 - dot / denom;
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += (a[i] - b[i]) ** 2;
    }
    return Math.sqrt(sum);
  }

  private randomLevel(): number {
    let level = 0;
    while (Math.random() < 0.5 && level < MAX_HNSW_LEVEL) level++;
    return level;
  }

  size(): number { return this.nodes.size; }

  exportNodes(): Map<number, NodeExport> {
    const exported = new Map<number, NodeExport>();
    for (const [id, node] of this.nodes) {
      const neighbors: Record<number, number[]> = {};
      for (const [level, nIds] of node.neighbors) {
        neighbors[level] = nIds;
      }
      exported.set(id, {
        id: node.id,
        docId: node.docId,
        level: node.level,
        neighbors,
      });
    }
    return exported;
  }

  /**
   * Rebuild the graph from persisted/imported nodes.
   *
   * The input comes from IndexedDB, which any same-origin script can write, so
   * it is validated before it can reach the search path: levels must be within
   * `MAX_HNSW_LEVEL`, adjacency must reference nodes that exist in the same
   * dump (and stay within the per-level cap), every vector must be a finite
   * Float32Array of the index's dimension and every node needs one. A bad dump
   * throws instead of producing an index that returns NaN distances.
   */
  importNodes(exported: NodeExport[], vectors: Map<number, Float32Array>): void {
    if (!Array.isArray(exported)) {
      throw new Error('HNSW import: nodes must be an array');
    }
    if (exported.length > MAX_HNSW_NODES) {
      throw new Error(`HNSW import: ${exported.length} nodes exceed the ${MAX_HNSW_NODES} quota`);
    }

    const ids = new Set<number>();
    for (const data of exported) {
      if (!data || typeof data !== 'object') {
        throw new Error('HNSW import: node entry must be an object');
      }
      if (!Number.isInteger(data.id) || data.id < 0) {
        throw new Error(`HNSW import: node id must be a non-negative integer, got ${JSON.stringify(data.id)}`);
      }
      if (ids.has(data.id)) {
        throw new Error(`HNSW import: duplicate node id ${data.id}`);
      }
      ids.add(data.id);
      if (typeof data.docId !== 'string' || !data.docId) {
        throw new Error(`HNSW import: node ${data.id} has an invalid docId`);
      }
      if (!Number.isInteger(data.level) || data.level < 0 || data.level > MAX_HNSW_LEVEL) {
        throw new Error(
          `HNSW import: node ${data.id} level ${JSON.stringify(data.level)} is outside 0..${MAX_HNSW_LEVEL}`,
        );
      }
      const vector = vectors.get(data.id);
      if (!vector) {
        throw new Error(`HNSW import: node ${data.id} has no vector`);
      }
      if (!(vector instanceof Float32Array) || vector.length !== this.dimensions) {
        throw new Error(
          `HNSW import: node ${data.id} vector must be a Float32Array of ${this.dimensions} dimensions`,
        );
      }
      for (let i = 0; i < vector.length; i++) {
        if (!Number.isFinite(vector[i])) {
          throw new Error(`HNSW import: node ${data.id} vector contains a non-finite value at ${i}`);
        }
      }
    }

    // Second pass: adjacency can only be checked once every id is known.
    for (const data of exported) {
      const neighbors = data.neighbors;
      if (!neighbors || typeof neighbors !== 'object') {
        throw new Error(`HNSW import: node ${data.id} has invalid neighbors`);
      }
      for (const [levelKey, nIds] of Object.entries(neighbors)) {
        const level = Number(levelKey);
        if (!Number.isInteger(level) || level < 0 || level > data.level) {
          throw new Error(
            `HNSW import: node ${data.id} has adjacency for level ${levelKey} above its level ${data.level}`,
          );
        }
        if (!Array.isArray(nIds)) {
          throw new Error(`HNSW import: node ${data.id} level ${levelKey} adjacency must be an array`);
        }
        if (nIds.length > MAX_HNSW_NEIGHBORS_PER_LEVEL) {
          throw new Error(
            `HNSW import: node ${data.id} level ${levelKey} has ${nIds.length} neighbors, above the ${MAX_HNSW_NEIGHBORS_PER_LEVEL} limit`,
          );
        }
        for (const nId of nIds) {
          if (!Number.isInteger(nId) || !ids.has(nId)) {
            throw new Error(`HNSW import: node ${data.id} references unknown neighbor ${JSON.stringify(nId)}`);
          }
        }
      }
    }

    for (const data of exported) {
      const neighbors = new Map<number, number[]>();
      for (const [level, nIds] of Object.entries(data.neighbors)) {
        neighbors.set(Number(level), [...nIds]);
      }
      const node: HNSWNode = {
        id: data.id,
        docId: data.docId,
        vector: vectors.get(data.id)!,
        level: data.level,
        neighbors,
      };
      this.nodes.set(data.id, node);
      this.docIdMap.set(data.docId, data.id);
      if (data.id >= this.nextNodeId) this.nextNodeId = data.id + 1;
      if (data.level > this.maxLevel) this.maxLevel = data.level;
    }
    if (this.nodes.size > 0 && this.enterPoint === null) {
      this.enterPoint = this.nodes.keys().next().value!;
    }
  }
}
