// Layer planning and the frame wire are derived from Nehanth/pooled
// (https://github.com/Nehanth/pooled), MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
import type { SwarmChainNode, SwarmRole, SwarmSessionPlan, SwarmSlice } from './types';
import { isSwarmPeerQualityReport, type SwarmPeerQualityReport } from './peer-quality';

/**
 * Swarm session runtime contracts. The coordinator plans the chain and relays
 * opaque hidden-state frames; nodes run one layer slice each. Everything the
 * coordinator and nodes must agree on lives here (single source of truth).
 */

// --- Layer planning ---

/**
 * Swarm sizing bounds. These are API contract, not tuning knobs: the worker
 * rejects a `swarm.minNodes`/`maxNodes` outside them, and a plan may never
 * exceed the layer bounds below. A host that proposes an absurd slice (e.g.
 * `end: 1e9`) would otherwise make a volunteer expand the whole model into GPU
 * memory and crash the tab.
 */
export const MIN_SWARM_NODES = 2;
export const MAX_SWARM_NODES = 16;
/** Deepest model the coordinator accepts a plan for. */
export const MAX_SWARM_LAYERS = 1024;
/** Most layers a single node may be asked to hold in one session. */
export const MAX_SWARM_SLICE_LAYERS = 256;

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
 * On the node/coordinator WebSocket this frame is wrapped with
 * `encodeSwarmEnvelope`, so frames from a retired attempt cannot enter a new one.
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

/** WebSocket envelope: bind an engine frame to one session attempt. */
/**
 * Length of the truncated HMAC-SHA256 trailer a hop adds to an envelope. 16
 * bytes (128 bits) is far past forging range for a per-hop session key while
 * staying small next to a hidden-state payload.
 */
export const SWARM_ENVELOPE_MAC_BYTES = 16;
/** Maximum complete session envelope carried over either DataChannel or relay. */
export const MAX_SWARM_ENVELOPE_BYTES = 8 * 1024 * 1024;

/**
 * WebSocket envelope: bind an engine frame to one session attempt, optionally
 * carrying the per-hop MAC that proves which neighbour produced it.
 *
 * Layout: u32 sessionIdLength, sessionId bytes, u8 macLength (0 or 16),
 * mac bytes, frame bytes. `macLength = 0` keeps the pre-MAC wire shape for
 * sessions that have no hop keys (a single-node chain never sends a frame).
 */
export function encodeSwarmEnvelope(sessionId: string, frame: ArrayBuffer, mac?: Uint8Array | null): ArrayBuffer {
  const id = new TextEncoder().encode(sessionId);
  if (!id.length || id.length > 256) throw new Error('swarm session id length is invalid');
  const macBytes = mac ?? new Uint8Array(0);
  if (macBytes.byteLength !== 0 && macBytes.byteLength !== SWARM_ENVELOPE_MAC_BYTES) {
    throw new Error('swarm envelope MAC length is invalid');
  }
  const frameOffset = 4 + id.length + 1 + macBytes.byteLength;
  if (frameOffset + frame.byteLength > MAX_SWARM_ENVELOPE_BYTES) {
    throw new Error(`swarm envelope exceeds ${MAX_SWARM_ENVELOPE_BYTES} bytes`);
  }
  const buffer = new ArrayBuffer(frameOffset + frame.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, id.length, true);
  new Uint8Array(buffer, 4, id.length).set(id);
  view.setUint8(4 + id.length, macBytes.byteLength);
  if (macBytes.byteLength) new Uint8Array(buffer, 4 + id.length + 1, macBytes.byteLength).set(macBytes);
  new Uint8Array(buffer, frameOffset).set(new Uint8Array(frame));
  return buffer;
}

export function decodeSwarmEnvelope(
  buffer: ArrayBuffer,
): { sessionId: string; frame: ArrayBuffer; mac: Uint8Array | null } | null {
  if (buffer.byteLength < 4 + 1 || buffer.byteLength > MAX_SWARM_ENVELOPE_BYTES) return null;
  const view = new DataView(buffer);
  const length = view.getUint32(0, true);
  if (!length || length > 256) return null;
  const macLengthOffset = 4 + length;
  if (buffer.byteLength < macLengthOffset + 1) return null;
  const macLength = view.getUint8(macLengthOffset);
  if (macLength !== 0 && macLength !== SWARM_ENVELOPE_MAC_BYTES) return null;
  const frameOffset = macLengthOffset + 1 + macLength;
  if (buffer.byteLength < frameOffset + SWARM_FRAME_HEADER_BYTES) return null;
  const sessionId = new TextDecoder().decode(new Uint8Array(buffer, 4, length));
  const mac = macLength ? new Uint8Array(buffer, macLengthOffset + 1, macLength) : null;
  return { sessionId, mac, frame: buffer.slice(frameOffset) };
}

/**
 * Per-hop frame authentication. The coordinator hands each member a fresh key
 * for each side of its hop (`inboundKey`/`outboundKey` on `swarm-slice`); a
 * member signs what it forwards with its outbound key and only accepts frames
 * signed with its inbound key, so one member cannot inject or rewrite a frame
 * as another hop.
 */
export async function computeSwarmFrameMac(key: string, sessionId: string, frame: ArrayBuffer): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encodeSwarmEnvelope(sessionId, frame));
  return new Uint8Array(signature).slice(0, SWARM_ENVELOPE_MAC_BYTES);
}

/** Sign an engine frame for the next hop. */
export async function signSwarmEnvelope(key: string, sessionId: string, frame: ArrayBuffer): Promise<ArrayBuffer> {
  const mac = await computeSwarmFrameMac(key, sessionId, frame);
  return encodeSwarmEnvelope(sessionId, frame, mac);
}

/** Constant-time check of a frame's hop MAC. */
export async function verifySwarmEnvelope(
  key: string,
  sessionId: string,
  frame: ArrayBuffer,
  mac: Uint8Array,
): Promise<boolean> {
  if (mac.byteLength !== SWARM_ENVELOPE_MAC_BYTES) return false;
  const expected = await computeSwarmFrameMac(key, sessionId, frame);
  let diff = 0;
  for (let i = 0; i < expected.byteLength; i++) diff |= expected[i] ^ mac[i];
  return diff === 0;
}

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
  // Remaining header fields stay zero: a stop carries no position or payload.
  return buffer;
}

export function isSwarmStopFrame(buffer: ArrayBuffer): boolean {
  // Stop is a header-only control frame, not a prefix marker: accepting trailing
  // bytes lets an oversized hidden-state frame masquerade as stop and bypass
  // payload validation in the worker's fast path.
  if (buffer.byteLength !== SWARM_FRAME_HEADER_BYTES) return false;
  const dv = new DataView(buffer);
  return (
    dv.getUint16(0, true) === SWARM_FRAME_MAGIC &&
    dv.getUint8(2) === SWARM_FRAME_KIND_STOP &&
    dv.getUint8(3) === 0 &&
    dv.getUint32(8, true) === 0 &&
    dv.getUint16(12, true) === 0 &&
    dv.getUint16(14, true) === 0
  );
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
//
// The coordinator brokers resources and relays frames; the host owns the plan.
// Flow: coordinator -> swarm-init (host) -> swarm-plan (host) -> swarm-slice
// (every node) -> swarm-ready (every node) -> swarm-start (host). The host then
// generates and frames circulate; the coordinator only routes them.
//
// A plan the coordinator rejects comes back the other way as swarm-error so the
// session settles immediately instead of waiting for the task timeout.

/** A chain member as offered to the host, with the capacity it can contribute. */
export interface SwarmMember {
  nodeId: string;
  capacity: number;
}

export interface SwarmInitMessage {
  type: 'swarm-init';
  sessionId: string;
  taskId: string;
  model: string;
  /** Task timeout in ms, so the host's worker knows its own deadline. */
  timeoutMs: number;
  /** Ordered members (index 0 is the host) with capacities for the split. */
  members: SwarmMember[];
  /** The generation request (the host owns generation). */
  prompt: string | string[];
  maxNewTokens?: number;
}

/** The host's layer plan; the coordinator stores it and hands out slices. */
export interface SwarmPlanMessage {
  type: 'swarm-plan';
  sessionId: string;
  chain: SwarmChainNode[];
}

export interface SwarmSliceMessage {
  type: 'swarm-slice';
  sessionId: string;
  taskId: string;
  /** Coordinator-generated attempt that fences peer signaling for this session. */
  attemptId?: string;
  /** Model id, so a worker can resolve and load its layer slice. */
  model: string;
  /** Task timeout in ms, so the worker knows its own deadline. */
  timeoutMs: number;
  /** This node's chain position (0 = host). */
  index: number;
  chainLength: number;
  /** Adjacent ring peers used by the optional WebRTC data path. */
  previousNodeId?: string;
  nextNodeId?: string;
  role: SwarmRole;
  slice: SwarmSlice;
  /**
   * Per-hop frame key for the frames this node receives (from the previous hop)
   * and sends (to the next hop). Base64url; absent on a single-node chain.
   */
  inboundKey?: string;
  outboundKey?: string;
}

export type SwarmPeerSignal =
  | { kind: 'description'; description: { type: 'offer' | 'answer'; sdp: string } }
  | {
      kind: 'candidate';
      candidate: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
      } | null;
    };

/** A bounded, coordinator-routed WebRTC signaling envelope. */
export interface SwarmPeerSignalMessage {
  type: 'swarm-peer-signal';
  taskId: string;
  sessionId: string;
  attemptId: string;
  toNodeId: string;
  /** Present only on signals relayed by the coordinator. */
  fromNodeId?: string;
  signal: SwarmPeerSignal;
}

/** Node-to-coordinator quality snapshot for at most the two adjacent peers. */
export interface SwarmPeerQualityMessage {
  type: 'swarm-peer-quality';
  taskId: string;
  sessionId: string;
  attemptId: string;
  reports: SwarmPeerQualityReport[];
}

export function isSwarmPeerQualityMessage(value: unknown, now = Date.now()): value is SwarmPeerQualityMessage {
  if (!isRecord(value) || value.type !== 'swarm-peer-quality') return false;
  if (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 128 ||
      typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 128 ||
      typeof value.attemptId !== 'string' || !value.attemptId || value.attemptId.length > 128 ||
      !Array.isArray(value.reports) || value.reports.length < 1 || value.reports.length > 2 ||
      !value.reports.every((report) => isSwarmPeerQualityReport(report, now))) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4096;
  } catch {
    return false;
  }
}

export const MAX_SWARM_SDP_CHARS = 24 * 1024;
export const MAX_SWARM_ICE_CANDIDATE_CHARS = 4096;
export const MAX_SWARM_SIGNAL_BYTES = 32 * 1024;

export function isSwarmPeerSignal(value: unknown): value is SwarmPeerSignal {
  if (!isRecord(value)) return false;
  if (value.kind === 'description') {
    const description = value.description;
    return (
      isRecord(description) &&
      (description.type === 'offer' || description.type === 'answer') &&
      typeof description.sdp === 'string' &&
      description.sdp.length > 0 &&
      description.sdp.length <= MAX_SWARM_SDP_CHARS
    );
  }
  if (value.kind === 'candidate') {
    const candidate = value.candidate;
    if (candidate === null) return true;
    return (
      isRecord(candidate) &&
      typeof candidate.candidate === 'string' &&
      candidate.candidate.length > 0 &&
      candidate.candidate.length <= MAX_SWARM_ICE_CANDIDATE_CHARS &&
      (candidate.sdpMid === undefined || candidate.sdpMid === null ||
        (typeof candidate.sdpMid === 'string' && candidate.sdpMid.length <= 128)) &&
      (candidate.sdpMLineIndex === undefined || candidate.sdpMLineIndex === null ||
        (typeof candidate.sdpMLineIndex === 'number' && Number.isInteger(candidate.sdpMLineIndex) &&
          candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 255)) &&
      (candidate.usernameFragment === undefined || candidate.usernameFragment === null ||
        (typeof candidate.usernameFragment === 'string' && candidate.usernameFragment.length <= 256))
    );
  }
  return false;
}

export function isSwarmPeerSignalMessage(value: unknown): value is SwarmPeerSignalMessage {
  if (!isRecord(value) || value.type !== 'swarm-peer-signal') return false;
  if (!isSwarmPeerSignal(value.signal)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value.signal)).byteLength > MAX_SWARM_SIGNAL_BYTES) return false;
  } catch {
    return false;
  }
  return (
    typeof value.taskId === 'string' && value.taskId.length > 0 && value.taskId.length <= 128 &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 128 &&
    typeof value.attemptId === 'string' && value.attemptId.length > 0 && value.attemptId.length <= 128 &&
    typeof value.toNodeId === 'string' && value.toNodeId.length > 0 && value.toNodeId.length <= 128 &&
    (value.fromNodeId === undefined ||
      (typeof value.fromNodeId === 'string' && value.fromNodeId.length > 0 && value.fromNodeId.length <= 128))
  );
}

/** Sent to the host once every member has loaded its slice. */
export interface SwarmStartMessage {
  type: 'swarm-start';
  sessionId: string;
  taskId: string;
}

export interface SwarmReadyMessage {
  type: 'swarm-ready';
  sessionId: string;
  /** True only after all adjacent DataChannels opened before the readiness deadline. */
  peerReady?: boolean;
}

/** Coordinator decision shared by every member before generation begins. */
export interface SwarmTransportMessage {
  type: 'swarm-transport';
  sessionId: string;
  taskId: string;
  mode: 'peer' | 'relay';
}

/** Pause or resume host generation when a bounded result subscriber falls behind. */
export interface SwarmFlowMessage {
  type: 'swarm-flow';
  sessionId: string;
  taskId: string;
  paused: boolean;
  attemptId?: string;
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
  /** Task the session belongs to, so the receiver can settle that task only. */
  taskId: string;
  error: string;
}

export type SwarmNodeMessage =
  | SwarmReadyMessage
  | SwarmPlanMessage
  | SwarmTokenMessage
  | SwarmDoneMessage
  | SwarmErrorMessage
  | SwarmPeerSignalMessage
  | SwarmPeerQualityMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Per-call overrides for the swarm sizing bounds declared with the layer
 * planner (`MAX_SWARM_LAYERS`, `MAX_SWARM_SLICE_LAYERS`, `MAX_SWARM_NODES`).
 */
export interface SwarmChainLimits {
  /** Hard cap on the total layer count a plan may cover. */
  maxLayers?: number;
  /** Hard cap on the number of layers any single slice may hold. */
  maxSliceLayers?: number;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate one node's slice: integral, non-empty and within the layer caps. */
export function isValidSwarmSlice(value: unknown, limits: SwarmChainLimits = {}): value is SwarmSlice {
  const maxLayers = limits.maxLayers ?? MAX_SWARM_LAYERS;
  const maxSliceLayers = limits.maxSliceLayers ?? MAX_SWARM_SLICE_LAYERS;
  if (!isSlice(value)) return false;
  if (!isNonNegativeInteger(value.start) || !isNonNegativeInteger(value.end)) return false;
  if (value.end <= value.start) return false;
  if (value.end - value.start > maxSliceLayers) return false;
  if (value.end > maxLayers) return false;
  return true;
}

function isSlice(value: unknown): value is SwarmSlice {
  if (!isRecord(value)) return false;
  return (
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.hasEmbed === 'boolean' &&
    typeof value.hasHead === 'boolean'
  );
}

function isMember(value: unknown): value is SwarmMember {
  if (!isRecord(value)) return false;
  return typeof value.nodeId === 'string' && value.nodeId.length > 0 && typeof value.capacity === 'number';
}

function isFrameKey(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128);
}

export function isSwarmInitMessage(value: unknown): value is SwarmInitMessage {
  if (!isRecord(value) || value.type !== 'swarm-init') return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  if (typeof value.taskId !== 'string' || !value.taskId) return false;
  if (typeof value.model !== 'string') return false;
  if (typeof value.timeoutMs !== 'number') return false;
  if (!Array.isArray(value.members) || value.members.length === 0) return false;
  if (value.members.length > MAX_SWARM_NODES) return false;
  if (typeof value.prompt !== 'string' && !Array.isArray(value.prompt)) return false;
  return value.members.every(isMember);
}

/** Validate a `swarm-slice` before a node loads anything from it. */
export function isSwarmSliceMessage(value: unknown): value is SwarmSliceMessage {
  if (!isRecord(value) || value.type !== 'swarm-slice') return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  if (typeof value.taskId !== 'string' || !value.taskId) return false;
  if (typeof value.model !== 'string' || !value.model) return false;
  if (typeof value.timeoutMs !== 'number') return false;
  if (!isNonNegativeInteger(value.index) || !isNonNegativeInteger(value.chainLength)) return false;
  if (value.chainLength < 1 || value.chainLength > MAX_SWARM_NODES) return false;
  if (value.index >= value.chainLength) return false;
  if (value.role !== (value.index === 0 ? 'host' : 'worker')) return false;
  if (!isValidSwarmSlice(value.slice)) return false;
  if (value.slice.hasEmbed !== (value.index === 0)) return false;
  if (value.slice.hasHead !== (value.index === 0)) return false;
  if (!isFrameKey(value.inboundKey) || !isFrameKey(value.outboundKey)) return false;
  if (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !value.attemptId || value.attemptId.length > 128)) return false;
  if (value.previousNodeId !== undefined && (typeof value.previousNodeId !== 'string' || !value.previousNodeId || value.previousNodeId.length > 128)) return false;
  if (value.nextNodeId !== undefined && (typeof value.nextNodeId !== 'string' || !value.nextNodeId || value.nextNodeId.length > 128)) return false;
  return true;
}

export function isSwarmStartMessage(value: unknown): value is SwarmStartMessage {
  if (!isRecord(value) || value.type !== 'swarm-start') return false;
  return typeof value.sessionId === 'string' && !!value.sessionId && typeof value.taskId === 'string' && !!value.taskId;
}

export function isSwarmTransportMessage(value: unknown): value is SwarmTransportMessage {
  if (!isRecord(value) || value.type !== 'swarm-transport') return false;
  return (
    typeof value.sessionId === 'string' && !!value.sessionId &&
    typeof value.taskId === 'string' && !!value.taskId &&
    (value.mode === 'peer' || value.mode === 'relay')
  );
}

export function isSwarmFlowMessage(value: unknown): value is SwarmFlowMessage {
  if (!isRecord(value) || value.type !== 'swarm-flow') return false;
  return (
    typeof value.sessionId === 'string' && !!value.sessionId &&
    typeof value.taskId === 'string' && !!value.taskId &&
    typeof value.paused === 'boolean' &&
    (value.attemptId === undefined || (typeof value.attemptId === 'string' && !!value.attemptId && value.attemptId.length <= 128))
  );
}

export function isSwarmErrorMessage(value: unknown): value is SwarmErrorMessage {
  if (!isRecord(value) || value.type !== 'swarm-error') return false;
  return (
    typeof value.sessionId === 'string' &&
    !!value.sessionId &&
    typeof value.taskId === 'string' &&
    !!value.taskId &&
    typeof value.error === 'string'
  );
}

/**
 * Validate a host-supplied plan before the coordinator stores it: the slices
 * must be non-empty, contiguous, cover every layer exactly once, stay within
 * the layer caps, and the first entry must be the host that owns the embedding
 * and head.
 *
 * Slice bounds are enforced too: layer indices must be non-negative integers,
 * the model may not be deeper than {@link MAX_SWARM_LAYERS}, and no single node
 * may be handed more than {@link MAX_SWARM_SLICE_LAYERS} layers. A malicious
 * host otherwise assigns a real volunteer `end: 1e9` and OOMs its GPU.
 */
export function isValidSwarmChain(chain: unknown, limits: SwarmChainLimits = {}): chain is SwarmChainNode[] {
  const maxLayers = limits.maxLayers ?? MAX_SWARM_LAYERS;
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_SWARM_NODES) return false;
  let cursor = 0;
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    if (!isRecord(node) || typeof node.nodeId !== 'string' || !node.nodeId) return false;
    if (node.role !== (i === 0 ? 'host' : 'worker')) return false;
    if (!isValidSwarmSlice(node.slice, limits)) return false;
    if (node.slice.start !== cursor) return false;
    if (node.slice.end > maxLayers) return false;
    if (node.slice.hasEmbed !== (i === 0)) return false;
    if (node.slice.hasHead !== (i === 0)) return false;
    cursor = node.slice.end;
  }
  return true;
}

export function isSwarmNodeMessage(value: unknown): value is SwarmNodeMessage {
  if (!isRecord(value)) return false;
  if (typeof value.sessionId !== 'string' || !value.sessionId) return false;
  switch (value.type) {
    case 'swarm-ready':
      return value.peerReady === undefined || typeof value.peerReady === 'boolean';
    case 'swarm-done':
      return true;
    case 'swarm-plan':
      return isValidSwarmChain(value.chain);
    case 'swarm-token':
      return typeof value.token === 'string';
    case 'swarm-error':
      return typeof value.taskId === 'string' && value.taskId.length > 0 && typeof value.error === 'string';
    case 'swarm-peer-signal':
      return isSwarmPeerSignalMessage(value);
    case 'swarm-peer-quality':
      return isSwarmPeerQualityMessage(value);
    default:
      return false;
  }
}
