import type { SwarmChainNode, SwarmRole, SwarmSessionPlan, SwarmSlice } from './types';

/**
 * Swarm session runtime contracts. The coordinator plans the chain and relays
 * opaque hidden-state frames; nodes run one layer slice each. Everything the
 * coordinator and nodes must agree on lives here (single source of truth).
 */

// --- Layer planning ---

/**
 * Deal `layers` consecutive transformer layers over devices in proportion to
 * capacity, giving every device at least one layer. The number of devices is
 * clamped to `layers` so a tiny model never yields empty slices. Ported from
 * Pooled's `planSplit` so node-side expectations match the engine's own split.
 */
export function planSwarmLayers(layers: number, capacities: number[]): number[] {
  if (capacities.length === 0) return [];
  if (!Number.isInteger(layers) || layers < 1) {
    throw new Error(`layers must be a positive integer, got ${layers}`);
  }

  const count = Math.min(capacities.length, layers);
  const caps = capacities.slice(0, count).map((c) => (Number.isFinite(c) && c > 0 ? c : 0));
  const total = caps.reduce((a, b) => a + b, 0) || 1;

  const assigned = caps.map((c) => Math.max(1, Math.floor((layers * c) / total)));
  let sum = assigned.reduce((a, b) => a + b, 0);

  // The per-device floor can overshoot when many devices are tiny; take layers
  // back from the largest until the total fits.
  while (sum > layers) {
    let largest = 0;
    for (let i = 1; i < count; i++) if (assigned[i] > assigned[largest]) largest = i;
    if (assigned[largest] <= 1) break;
    assigned[largest]--;
    sum--;
  }

  // Hand out the remainder by largest fractional part, as planSplit does.
  const fracs = caps
    .map((c, i) => ({ i, f: (layers * c) / total - Math.floor((layers * c) / total) }))
    .sort((a, b) => b.f - a.f);
  let k = 0;
  while (sum < layers) {
    assigned[fracs[k % count].i]++;
    sum++;
    k++;
  }

  return assigned;
}

export interface SwarmChainRequest {
  sessionId: string;
  taskId: string;
  model: string;
  layers: number;
  /** Nodes in chain order (index 0 becomes the host). */
  nodes: Array<{ nodeId: string; capacity: number }>;
}

/**
 * Build the ordered host/worker chain with contiguous, non-overlapping slices.
 * Index 0 is the host and owns the embedding, LM head and sampling loop.
 */
export function buildSwarmChain(request: SwarmChainRequest): SwarmSessionPlan {
  const counts = planSwarmLayers(
    request.layers,
    request.nodes.map((n) => n.capacity),
  );
  const chain: SwarmChainNode[] = [];
  let start = 0;
  for (let i = 0; i < counts.length; i++) {
    const end = start + counts[i];
    const role: SwarmRole = i === 0 ? 'host' : 'worker';
    const slice: SwarmSlice = { start, end, hasEmbed: i === 0, hasHead: i === 0 };
    chain.push({ nodeId: request.nodes[i].nodeId, role, slice });
    start = end;
  }
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    model: request.model,
    layers: request.layers,
    chain,
  };
}

// --- Chain routing ---

/** Position of a node in the chain, or -1 when it is not a member. */
export function swarmChainIndex(plan: SwarmSessionPlan, nodeId: string): number {
  return plan.chain.findIndex((n) => n.nodeId === nodeId);
}

/**
 * Where a hidden-state frame goes next. The chain is a ring: the host embeds
 * and sends to the next hop, each hop runs its layers and forwards, and the
 * last hop returns the result to the host (`chainLength - 1` -> `0`).
 */
export function swarmNextHopIndex(chainLength: number, fromIndex: number): number {
  if (chainLength <= 0) return -1;
  return (fromIndex + 1) % chainLength;
}

// --- Hidden-state frame codec ---

/**
 * 16-byte header prepended to every hidden-state payload. The coordinator reads
 * only the header (to route by session chain position) and copies the payload
 * through untouched; f16 packing of the payload itself is the node's concern.
 *
 * Layout (little-endian): u16 magic, u8 kind, u8 flags, u32 requestId,
 * u32 pos, u16 tokens, u16 reserved.
 */
export const SWARM_FRAME_MAGIC = 0x5357; // "SW"
export const SWARM_FRAME_HEADER_BYTES = 16;
const SWARM_FRAME_KIND_HIDDEN = 0;
const SWARM_FRAME_KIND_STOP = 1;

export const SWARM_FRAME_KIND = {
  hidden: SWARM_FRAME_KIND_HIDDEN,
  stop: SWARM_FRAME_KIND_STOP,
} as const;

export interface SwarmFrameHeader {
  /** Correlates a round trip; the host increments it per frame. */
  requestId: number;
  /** Sequence position of the first token in the frame. */
  pos: number;
  /** Number of token columns packed in the payload. */
  tokens: number;
}

export function encodeSwarmFrame(header: SwarmFrameHeader, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(SWARM_FRAME_HEADER_BYTES + payload.byteLength);
  const dv = new DataView(buffer);
  dv.setUint16(0, SWARM_FRAME_MAGIC, true);
  dv.setUint8(2, SWARM_FRAME_KIND_HIDDEN);
  dv.setUint8(3, 0);
  dv.setUint32(4, header.requestId >>> 0, true);
  dv.setUint32(8, header.pos >>> 0, true);
  dv.setUint16(12, header.tokens, true);
  dv.setUint16(14, 0, true);
  new Uint8Array(buffer, SWARM_FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

/**
 * An empty control frame that travels the chain once and tells every worker its
 * session is over. The host sends it after the generation loop; each worker
 * forwards it and stops. Carries no hidden state.
 */
export function encodeSwarmStopFrame(requestId = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(SWARM_FRAME_HEADER_BYTES);
  const dv = new DataView(buffer);
  dv.setUint16(0, SWARM_FRAME_MAGIC, true);
  dv.setUint8(2, SWARM_FRAME_KIND_STOP);
  dv.setUint8(3, 0);
  dv.setUint32(4, requestId >>> 0, true);
  return buffer;
}

export function isSwarmStopFrame(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < SWARM_FRAME_HEADER_BYTES) return false;
  const dv = new DataView(buffer);
  return dv.getUint16(0, true) === SWARM_FRAME_MAGIC && dv.getUint8(2) === SWARM_FRAME_KIND_STOP;
}

export function decodeSwarmFrame(
  buffer: ArrayBuffer,
): { header: SwarmFrameHeader; payload: Uint8Array } | null {
  if (buffer.byteLength < SWARM_FRAME_HEADER_BYTES) return null;
  const dv = new DataView(buffer);
  if (dv.getUint16(0, true) !== SWARM_FRAME_MAGIC) return null;
  if (dv.getUint8(2) !== SWARM_FRAME_KIND_HIDDEN) return null;
  return {
    header: {
      requestId: dv.getUint32(4, true),
      pos: dv.getUint32(8, true),
      tokens: dv.getUint16(12, true),
    },
    payload: new Uint8Array(buffer, SWARM_FRAME_HEADER_BYTES),
  };
}

// --- Coordinator <-> node control messages ---

export interface SwarmInitMessage {
  type: 'swarm-init';
  sessionId: string;
  taskId: string;
  model: string;
  layers: number;
  /** This node's chain position (0 = host). */
  index: number;
  chainLength: number;
  role: SwarmRole;
  slice: SwarmSlice;
}

export interface SwarmReadyMessage {
  type: 'swarm-ready';
  sessionId: string;
}

export interface SwarmTokenMessage {
  type: 'swarm-token';
  sessionId: string;
  /** Decoded token text (the host emits, the coordinator streams to subscribers). */
  token: string;
}

export interface SwarmDoneMessage {
  type: 'swarm-done';
  sessionId: string;
}

export interface SwarmErrorMessage {
  type: 'swarm-error';
  sessionId: string;
  error: string;
}

export type SwarmNodeMessage =
  | SwarmReadyMessage
  | SwarmTokenMessage
  | SwarmDoneMessage
  | SwarmErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSwarmInitMessage(value: unknown): value is SwarmInitMessage {
  if (!isRecord(value) || value.type !== 'swarm-init') return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  if (typeof value.taskId !== 'string' || !value.taskId) return false;
  if (typeof value.model !== 'string') return false;
  if (typeof value.layers !== 'number' || !Number.isInteger(value.layers) || value.layers < 1) return false;
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) return false;
  if (typeof value.chainLength !== 'number' || !Number.isInteger(value.chainLength) || value.chainLength < 1) return false;
  if (value.role !== 'host' && value.role !== 'worker') return false;
  const slice = value.slice;
  if (!isRecord(slice)) return false;
  if (typeof slice.start !== 'number' || typeof slice.end !== 'number') return false;
  if (typeof slice.hasEmbed !== 'boolean' || typeof slice.hasHead !== 'boolean') return false;
  return true;
}

export function isSwarmNodeMessage(value: unknown): value is SwarmNodeMessage {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  switch (value.type) {
    case 'swarm-ready':
    case 'swarm-done':
      return true;
    case 'swarm-token':
      return typeof value.token === 'string';
    case 'swarm-error':
      return typeof value.error === 'string';
    default:
      return false;
  }
}
