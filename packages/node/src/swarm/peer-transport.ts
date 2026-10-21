import { isSwarmPeerSignalMessage, MAX_SWARM_ENVELOPE_BYTES } from '@flaxia/sdk';
import type { SwarmPeerSignal, SwarmPeerSignalMessage } from '@flaxia/sdk';

export const SWARM_PEER_CONNECT_TIMEOUT_MS = 5000;
export const SWARM_PEER_FRAME_CHUNK_BYTES = 16 * 1024;
export const MAX_SWARM_PEER_FRAME_BYTES = MAX_SWARM_ENVELOPE_BYTES;
export const MAX_SWARM_PEER_BUFFERED_BYTES = 256 * 1024;

const PACKET_MAGIC = 0x43584c46; // "FLXC"
const PACKET_HEADER_BYTES = 16;
const MAX_INCOMPLETE_FRAMES = 2;
const MAX_PENDING_CANDIDATES = 64;
const CHANNEL_NAME = 'flaxia-swarm-v1';
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

interface PeerChunk {
  messageId: number;
  index: number;
  count: number;
  totalBytes: number;
  payload: Uint8Array;
}

interface FrameAssembly {
  count: number;
  totalBytes: number;
  parts: Array<Uint8Array | undefined>;
  received: number;
  receivedBytes: number;
  createdAt: number;
}

function decodePeerChunk(packet: ArrayBuffer): PeerChunk | null {
  if (packet.byteLength < PACKET_HEADER_BYTES || packet.byteLength > PACKET_HEADER_BYTES + SWARM_PEER_FRAME_CHUNK_BYTES) {
    return null;
  }
  const view = new DataView(packet);
  if (view.getUint32(0, true) !== PACKET_MAGIC) return null;
  const messageId = view.getUint32(4, true);
  const index = view.getUint16(8, true);
  const count = view.getUint16(10, true);
  const totalBytes = view.getUint32(12, true);
  if (totalBytes < 1 || totalBytes > MAX_SWARM_PEER_FRAME_BYTES || count < 1) return null;
  const expectedCount = Math.ceil(totalBytes / SWARM_PEER_FRAME_CHUNK_BYTES);
  if (count !== expectedCount || index >= count) return null;
  const expectedBytes = Math.min(SWARM_PEER_FRAME_CHUNK_BYTES, totalBytes - index * SWARM_PEER_FRAME_CHUNK_BYTES);
  if (packet.byteLength - PACKET_HEADER_BYTES !== expectedBytes) return null;
  return {
    messageId,
    index,
    count,
    totalBytes,
    payload: new Uint8Array(packet, PACKET_HEADER_BYTES),
  };
}

/** Split one ordered frame into bounded DataChannel packets. */
export function encodeSwarmPeerFrame(frame: ArrayBuffer, messageId: number): ArrayBuffer[] {
  if (frame.byteLength < 1 || frame.byteLength > MAX_SWARM_PEER_FRAME_BYTES) {
    throw new Error(`swarm peer frame size is outside 1..${MAX_SWARM_PEER_FRAME_BYTES} bytes`);
  }
  const count = Math.ceil(frame.byteLength / SWARM_PEER_FRAME_CHUNK_BYTES);
  const packets: ArrayBuffer[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * SWARM_PEER_FRAME_CHUNK_BYTES;
    const end = Math.min(start + SWARM_PEER_FRAME_CHUNK_BYTES, frame.byteLength);
    const payload = new Uint8Array(frame, start, end - start);
    const packet = new ArrayBuffer(PACKET_HEADER_BYTES + payload.byteLength);
    const view = new DataView(packet);
    view.setUint32(0, PACKET_MAGIC, true);
    view.setUint32(4, messageId >>> 0, true);
    view.setUint16(8, index, true);
    view.setUint16(10, count, true);
    view.setUint32(12, frame.byteLength, true);
    new Uint8Array(packet, PACKET_HEADER_BYTES).set(payload);
    packets.push(packet);
  }
  return packets;
}

/** Reassemble ordered or out-of-order chunks while bounding untrusted peer memory. */
export class SwarmPeerFrameReassembler {
  private assemblies = new Map<number, FrameAssembly>();

  accept(packet: ArrayBuffer, now = Date.now()): ArrayBuffer | null {
    this.expire(now);
    const chunk = decodePeerChunk(packet);
    if (!chunk) return null;
    let assembly = this.assemblies.get(chunk.messageId);
    if (!assembly) {
      if (this.assemblies.size >= MAX_INCOMPLETE_FRAMES) return null;
      assembly = {
        count: chunk.count,
        totalBytes: chunk.totalBytes,
        parts: new Array(chunk.count),
        received: 0,
        receivedBytes: 0,
        createdAt: now,
      };
      this.assemblies.set(chunk.messageId, assembly);
    }
    if (assembly.count !== chunk.count || assembly.totalBytes !== chunk.totalBytes) {
      this.assemblies.delete(chunk.messageId);
      return null;
    }
    const previous = assembly.parts[chunk.index];
    if (previous) {
      // A duplicate packet is harmless; conflicting duplicates invalidate the frame.
      if (previous.byteLength === chunk.payload.byteLength && previous.every((byte, i) => byte === chunk.payload[i])) {
        return null;
      }
      this.assemblies.delete(chunk.messageId);
      return null;
    }
    const copy = chunk.payload.slice();
    assembly.parts[chunk.index] = copy;
    assembly.received++;
    assembly.receivedBytes += copy.byteLength;
    if (assembly.receivedBytes > assembly.totalBytes) {
      this.assemblies.delete(chunk.messageId);
      return null;
    }
    if (assembly.received !== assembly.count) return null;
    if (assembly.receivedBytes !== assembly.totalBytes) {
      this.assemblies.delete(chunk.messageId);
      return null;
    }

    const frame = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (const part of assembly.parts) {
      if (!part) {
        this.assemblies.delete(chunk.messageId);
        return null;
      }
      frame.set(part, offset);
      offset += part.byteLength;
    }
    this.assemblies.delete(chunk.messageId);
    return frame.buffer;
  }

  clear() {
    this.assemblies.clear();
  }

  private expire(now: number) {
    for (const [id, assembly] of this.assemblies) {
      if (now - assembly.createdAt > SWARM_PEER_CONNECT_TIMEOUT_MS * 2) this.assemblies.delete(id);
    }
  }
}

interface PeerState {
  nodeId: string;
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  remoteDescriptionSet: boolean;
  pendingCandidates: RTCIceCandidateInit[];
}

export interface SwarmPeerTransportOptions {
  sessionId: string;
  taskId: string;
  attemptId: string;
  nodeId: string;
  previousNodeId?: string;
  nextNodeId?: string;
  onSignal: (toNodeId: string, signal: SwarmPeerSignal) => void;
  onFrame: (frame: ArrayBuffer) => void;
  onFailure: (error: Error) => void;
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  connectTimeoutMs?: number;
  now?: () => number;
};

/**
 * One session's adjacent WebRTC data links. Each chain edge has one offerer;
 * an open ordered DataChannel carries hidden frames in both directions. The
 * coordinator selects relay globally if any member cannot open all of its links.
 */
export class SwarmPeerTransport {
  private peers = new Map<string, PeerState>();
  private reassembler = new SwarmPeerFrameReassembler();
  private nextMessageId = 1;
  private mode: 'undecided' | 'peer' | 'relay' = 'undecided';
  private closed = false;
  private failed = false;
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ready: boolean) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SwarmPeerTransportOptions) {}

  get selectedMode(): 'undecided' | 'peer' | 'relay' {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.closed || this.peers.size) return;
    if (typeof RTCPeerConnection === 'undefined' && !this.options.createPeerConnection) {
      this.unavailable();
      return;
    }
    const neighborIds = [...new Set([this.options.previousNodeId, this.options.nextNodeId])]
      .filter((id): id is string => !!id && id !== this.options.nodeId);
    try {
      for (const nodeId of neighborIds) {
        const create = this.options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration));
        const connection = create({ iceServers: DEFAULT_ICE_SERVERS });
        const state: PeerState = { nodeId, connection, channel: null, remoteDescriptionSet: false, pendingCandidates: [] };
        this.peers.set(nodeId, state);
        connection.onicecandidate = (event) => {
          const candidate = event.candidate;
          this.options.onSignal(nodeId, {
            kind: 'candidate',
            candidate: candidate?.candidate ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            } : null,
          });
        };
        connection.ondatachannel = (event) => this.bindChannel(state, event.channel);
        connection.onconnectionstatechange = () => {
          if (connection.connectionState === 'failed' || connection.connectionState === 'closed') this.unavailable();
        };

        // A stable node-id ordering prevents simultaneous-offer glare, including
        // the two-node ring where previous and next are the same peer.
        if (this.options.nodeId.localeCompare(nodeId) < 0) {
          this.bindChannel(state, connection.createDataChannel(CHANNEL_NAME, { ordered: true }));
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          const local = connection.localDescription;
          if (!local?.sdp || (local.type !== 'offer' && local.type !== 'answer')) throw new Error('empty local SDP offer');
          this.options.onSignal(nodeId, { kind: 'description', description: { type: local.type, sdp: local.sdp } });
        }
      }
      this.resolveReadyIfOpen();
    } catch (error) {
      this.unavailable(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async handleSignal(fromNodeId: string, signal: SwarmPeerSignal): Promise<void> {
    if (this.closed || this.failed) return;
    const peer = this.peers.get(fromNodeId);
    if (!peer) return;
    try {
      if (signal.kind === 'description') {
        await peer.connection.setRemoteDescription(signal.description);
        peer.remoteDescriptionSet = true;
        for (const candidate of peer.pendingCandidates.splice(0)) await peer.connection.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          const answer = await peer.connection.createAnswer();
          await peer.connection.setLocalDescription(answer);
          const local = peer.connection.localDescription;
          if (!local?.sdp || (local.type !== 'offer' && local.type !== 'answer')) throw new Error('empty local SDP answer');
          this.options.onSignal(fromNodeId, { kind: 'description', description: { type: local.type, sdp: local.sdp } });
        }
      } else if (signal.candidate !== null) {
        if (!peer.remoteDescriptionSet) {
          if (peer.pendingCandidates.length >= MAX_PENDING_CANDIDATES) throw new Error('too many ICE candidates before remote description');
          peer.pendingCandidates.push(signal.candidate);
        } else {
          await peer.connection.addIceCandidate(signal.candidate);
        }
      }
    } catch (error) {
      this.unavailable(error instanceof Error ? error : new Error(String(error)));
    }
  }

  waitUntilReady(timeoutMs = this.options.connectTimeoutMs ?? SWARM_PEER_CONNECT_TIMEOUT_MS): Promise<boolean> {
    if (this.mode !== 'undecided') return Promise.resolve(this.mode === 'peer');
    if (this.readyPromise) return this.readyPromise;
    if (this.failed || this.closed || !this.peers.size) return Promise.resolve(false);
    if (this.allPeersOpen()) return Promise.resolve(true);
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
      this.readyTimer = setTimeout(() => this.resolveReady(this.allPeersOpen()), timeoutMs);
    });
    return this.readyPromise;
  }

  selectMode(mode: 'peer' | 'relay'): void {
    if (this.closed || this.mode !== 'undecided') return;
    this.mode = mode;
    if (mode === 'relay') {
      this.closePeerConnections();
      return;
    }
    if (!this.allPeersOpen()) this.unavailable(new Error('peer mode selected without every data channel open'));
  }

  async sendFrame(frame: ArrayBuffer): Promise<boolean> {
    if (this.mode !== 'peer') return false;
    const nextId = this.options.nextNodeId;
    const channel = nextId ? this.peers.get(nextId)?.channel : undefined;
    if (!channel || channel.readyState !== 'open') {
      const error = new Error('swarm peer data channel closed during the session');
      this.unavailable(error);
      throw error;
    }
    const messageId = this.nextMessageId++ >>> 0;
    try {
      for (const packet of encodeSwarmPeerFrame(frame, messageId)) {
        await this.waitForBuffer(channel);
        if (channel.readyState !== 'open') throw new Error('swarm peer data channel closed while sending');
        channel.send(packet);
      }
      return true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.unavailable(normalized);
      throw normalized;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveReady(false);
    this.closePeerConnections();
    this.reassembler.clear();
  }

  private bindChannel(peer: PeerState, channel: RTCDataChannel) {
    if (peer.channel && peer.channel !== channel) {
      try { channel.close(); } catch {}
      return;
    }
    peer.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = MAX_SWARM_PEER_BUFFERED_BYTES / 2;
    channel.onopen = () => this.resolveReadyIfOpen();
    channel.onmessage = (event) => {
      if (peer.nodeId !== this.options.previousNodeId || !(event.data instanceof ArrayBuffer)) return;
      const frame = this.reassembler.accept(event.data, this.options.now?.());
      if (frame) this.options.onFrame(frame);
    };
    channel.onclose = () => this.unavailable(new Error('swarm peer data channel closed'));
    channel.onerror = () => this.unavailable(new Error('swarm peer data channel failed'));
    this.resolveReadyIfOpen();
  }

  private allPeersOpen(): boolean {
    if (!this.peers.size) return false;
    return [...this.peers.values()].every((peer) => peer.channel?.readyState === 'open');
  }

  private resolveReadyIfOpen() {
    if (this.allPeersOpen()) this.resolveReady(true);
  }

  private resolveReady(ready: boolean) {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    resolve?.(ready && !this.failed && !this.closed);
  }

  private unavailable(error = new Error('swarm peer link unavailable')) {
    if (this.closed) return;
    if (!this.failed) {
      this.failed = true;
      this.resolveReady(false);
      if (this.mode === 'peer') this.options.onFailure(error);
    }
  }

  private async waitForBuffer(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= MAX_SWARM_PEER_BUFFERED_BYTES) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('swarm peer send buffer stalled')), SWARM_PEER_CONNECT_TIMEOUT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onLow = () => finish();
      const onClose = () => finish(new Error('swarm peer data channel closed while backpressured'));
      channel.addEventListener('bufferedamountlow', onLow, { once: true });
      channel.addEventListener('close', onClose, { once: true });
    });
  }

  private closePeerConnections() {
    for (const peer of this.peers.values()) {
      peer.channel?.close();
      peer.connection.close();
    }
    this.peers.clear();
  }
}

export function isCurrentSwarmPeerSignal(
  message: unknown,
  expected: { taskId: string; sessionId: string; attemptId: string; nodeId: string; peers: string[] },
): message is SwarmPeerSignalMessage {
  if (!isSwarmPeerSignalMessage(message)) return false;
  const candidate = message;
  return (
    candidate.type === 'swarm-peer-signal' &&
    candidate.taskId === expected.taskId &&
    candidate.sessionId === expected.sessionId &&
    candidate.attemptId === expected.attemptId &&
    candidate.toNodeId === expected.nodeId &&
    typeof candidate.fromNodeId === 'string' && expected.peers.includes(candidate.fromNodeId) &&
    typeof candidate.signal === 'object' && candidate.signal !== null
  );
}
