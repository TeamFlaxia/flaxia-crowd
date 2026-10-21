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
});
