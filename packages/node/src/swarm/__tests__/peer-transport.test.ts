import { describe, expect, it, vi } from 'vitest';
import {
  encodeSwarmPeerFrame,
  isCurrentSwarmPeerSignal,
  SwarmPeerFrameReassembler,
  SwarmPeerTransport,
  SWARM_PEER_FRAME_CHUNK_BYTES,
} from '../peer-transport';

describe('swarm peer frame transport', () => {
  it('reassembles bounded frames when chunks arrive out of order', () => {
    const input = Uint8Array.from({ length: SWARM_PEER_FRAME_CHUNK_BYTES * 2 + 91 }, (_, i) => i % 251);
    const packets = encodeSwarmPeerFrame(input.buffer, 42);
    const reassembler = new SwarmPeerFrameReassembler();

    expect(packets).toHaveLength(3);
    expect(reassembler.accept(packets[2])).toBeNull();
    expect(reassembler.accept(packets[0])).toBeNull();
    const result = reassembler.accept(packets[1]);
    expect(result).not.toBeNull();
    expect(new Uint8Array(result!)).toEqual(input);
  });

  it('rejects empty and oversized peer frames', () => {
    expect(() => encodeSwarmPeerFrame(new ArrayBuffer(0), 1)).toThrow(/size/);
    expect(() => encodeSwarmPeerFrame(new ArrayBuffer(8 * 1024 * 1024 + 1), 1)).toThrow(/size/);
  });

  it('validates a signal against task, session, attempt, destination, and adjacency', () => {
    const signal = {
      type: 'swarm-peer-signal',
      taskId: 'task',
      sessionId: 'session',
      attemptId: 'attempt',
      fromNodeId: 'left',
      toNodeId: 'self',
      signal: { kind: 'candidate', candidate: null },
    };
    const expected = { taskId: 'task', sessionId: 'session', attemptId: 'attempt', nodeId: 'self', peers: ['left'] };

    expect(isCurrentSwarmPeerSignal(signal, expected)).toBe(true);
    expect(isCurrentSwarmPeerSignal({ ...signal, attemptId: 'stale' }, expected)).toBe(false);
    expect(isCurrentSwarmPeerSignal({ ...signal, fromNodeId: 'outsider' }, expected)).toBe(false);
  });

  it('selects coordinator relay when WebRTC is unavailable', async () => {
    const onFailure = vi.fn();
    const transport = new SwarmPeerTransport({
      sessionId: 'session',
      taskId: 'task',
      attemptId: 'attempt',
      nodeId: 'a',
      nextNodeId: 'b',
      onSignal: vi.fn(),
      onFrame: vi.fn(),
      onFailure,
      createPeerConnection: () => { throw new Error('RTC unavailable'); },
    });

    await transport.start();
    expect(await transport.waitUntilReady()).toBe(false);
    transport.selectMode('relay');
    expect(await transport.sendFrame(new Uint8Array([1]).buffer)).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
    transport.close();
  });

  it('reports application RTT separately from WebRTC path statistics', async () => {
    vi.useFakeTimers();
    try {
      let monotonicNow = 0;
      let wallNow = 10_000;
      const reports: Array<{ peerNodeId: string; webRtc: any; application: any }> = [];
      const channel = new FakeDataChannel();
      const connection = new FakePeerConnection(channel);
      const transport = new SwarmPeerTransport({
        sessionId: 'session',
        taskId: 'task',
        attemptId: 'attempt',
        nodeId: 'a',
        nextNodeId: 'b',
        onSignal: vi.fn(),
        onFrame: vi.fn(),
        onQuality: (batch) => reports.push(...batch),
        onFailure: vi.fn(),
        createPeerConnection: () => connection as unknown as RTCPeerConnection,
        now: () => wallNow,
        monotonicNow: () => monotonicNow,
      });

      await transport.start();
      transport.selectMode('peer');
      await flushPromises();
      expect(reports).toHaveLength(1);
      expect(reports[0].webRtc.rttMs.value).toBe(20);

      const ping = channel.sent.map((item) => JSON.parse(String(item)))
        .find((message) => message.type === 'flaxia-peer-quality-v1' && message.kind === 'ping');
      expect(ping).toBeDefined();
      monotonicNow = 82;
      const onMessage = channel.onmessage as unknown as ((event: MessageEvent) => void) | null;
      onMessage?.({ data: JSON.stringify({ type: 'flaxia-peer-quality-v1', kind: 'pong', id: ping.id }) } as MessageEvent);

      connection.rttSeconds = 0.05;
      connection.outgoingBitrate = 2_000_000;
      connection.bytesSent = 125_000;
      connection.bytesReceived = 62_500;
      monotonicNow = 15_000;
      wallNow = 25_000;
      await vi.advanceTimersByTimeAsync(15_000);
      await flushPromises();

      expect(reports).toHaveLength(2);
      expect(reports[1].webRtc.rttMs.value).toBe(50);
      expect(reports[1].webRtc.sendMbps.value).toBe(2);
      expect(reports[1].application.rttMs.value).toBe(82);
      expect(reports[1].application.sendMbps.value).toBe(0);
      expect(reports[1].application.jitterMs.value).toBeNull();
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function flushPromises() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  onmessage: ((this: RTCDataChannel, ev: MessageEvent) => any) | null = null;
  onclose: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  onerror: ((this: RTCDataChannel, ev: Event) => any) | null = null;
  sent: unknown[] = [];
  send(data: string | Blob | ArrayBuffer | ArrayBufferView) { this.sent.push(data); }
  close() { this.readyState = 'closed'; }
  addEventListener() {}
  removeEventListener() {}
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null = null;
  ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null = null;
  onconnectionstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null = null;
  rttSeconds = 0.02;
  outgoingBitrate = 1_000_000;
  bytesSent = 0;
  bytesReceived = 0;

  constructor(private readonly channel: FakeDataChannel) {}
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: 'offer' as const, sdp: 'offer' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async getStats() {
    return new Map([
      ['candidate-pair', {
        id: 'candidate-pair', type: 'candidate-pair', state: 'succeeded', selected: true,
        currentRoundTripTime: this.rttSeconds, availableOutgoingBitrate: this.outgoingBitrate,
      }],
      ['data-channel', { id: 'data-channel', type: 'data-channel', state: 'open', bytesSent: this.bytesSent, bytesReceived: this.bytesReceived }],
    ]) as unknown as RTCStatsReport;
  }
  close() { this.connectionState = 'closed'; }
}
