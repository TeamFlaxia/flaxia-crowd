import { describe, it, expect } from 'vitest';
import type { SwarmSessionPlan } from '../types';
import {
  planSwarmLayers,
  buildSwarmChain,
  swarmChainIndex,
  swarmNextHopIndex,
  encodeSwarmFrame,
  decodeSwarmFrame,
  isSwarmInitMessage,
  isSwarmNodeMessage,
  SWARM_FRAME_MAGIC,
  SWARM_FRAME_HEADER_BYTES,
} from '../swarm';

describe('planSwarmLayers', () => {
  it('splits proportionally to capacity', () => {
    expect(planSwarmLayers(8, [1, 1])).toEqual([4, 4]);
    expect(planSwarmLayers(8, [3, 1])).toEqual([6, 2]);
  });

  it('always gives every device at least one layer and sums to the total', () => {
    const counts = planSwarmLayers(3, [100, 1, 1]);
    expect(counts).toEqual([1, 1, 1]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('distributes the rounding remainder over all devices', () => {
    const counts = planSwarmLayers(8, [1, 1, 1]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
    expect(counts.every((c) => c >= 2)).toBe(true);
    expect(counts.sort((a, b) => a - b)).toEqual([2, 3, 3]);
  });

  it('clamps the node count to the layer count', () => {
    expect(planSwarmLayers(2, [1, 1, 1])).toEqual([1, 1]);
  });

  it('returns no slices for no devices', () => {
    expect(planSwarmLayers(8, [])).toEqual([]);
  });

  it('rejects a non-positive or fractional layer count', () => {
    expect(() => planSwarmLayers(0, [1])).toThrow();
    expect(() => planSwarmLayers(2.5, [1])).toThrow();
  });
});

describe('buildSwarmChain', () => {
  it('gives the host the embedding and head and lays slices end to end', () => {
    const plan = buildSwarmChain({
      sessionId: 's1',
      taskId: 't1',
      model: 'qwen3-1.7b',
      layers: 8,
      nodes: [
        { nodeId: 'a', capacity: 3 },
        { nodeId: 'b', capacity: 1 },
      ],
    });

    expect(plan.chain).toEqual([
      { nodeId: 'a', role: 'host', slice: { start: 0, end: 6, hasEmbed: true, hasHead: true } },
      { nodeId: 'b', role: 'worker', slice: { start: 6, end: 8, hasEmbed: false, hasHead: false } },
    ]);
    expect(plan.layers).toBe(8);
  });

  it('covers every layer exactly once with no gaps', () => {
    const plan = buildSwarmChain({
      sessionId: 's1',
      taskId: 't1',
      model: 'm',
      layers: 10,
      nodes: [
        { nodeId: 'a', capacity: 1 },
        { nodeId: 'b', capacity: 1 },
        { nodeId: 'c', capacity: 1 },
      ],
    });
    let cursor = 0;
    for (const node of plan.chain) {
      expect(node.slice.start).toBe(cursor);
      expect(node.slice.end).toBeGreaterThan(node.slice.start);
      cursor = node.slice.end;
    }
    expect(cursor).toBe(10);
  });
});

describe('chain routing', () => {
  const plan: SwarmSessionPlan = {
    sessionId: 's',
    taskId: 't',
    model: 'm',
    layers: 6,
    chain: [
      { nodeId: 'host', role: 'host', slice: { start: 0, end: 3, hasEmbed: true, hasHead: true } },
      { nodeId: 'mid', role: 'worker', slice: { start: 3, end: 5, hasEmbed: false, hasHead: false } },
      { nodeId: 'last', role: 'worker', slice: { start: 5, end: 6, hasEmbed: false, hasHead: false } },
    ],
  };

  it('finds a node position and reports non-members', () => {
    expect(swarmChainIndex(plan, 'mid')).toBe(1);
    expect(swarmChainIndex(plan, 'nope')).toBe(-1);
  });

  it('advances the ring and loops the last hop back to the host', () => {
    expect(swarmNextHopIndex(3, 0)).toBe(1);
    expect(swarmNextHopIndex(3, 1)).toBe(2);
    expect(swarmNextHopIndex(3, 2)).toBe(0);
    expect(swarmNextHopIndex(0, 0)).toBe(-1);
  });
});

describe('swarm frame codec', () => {
  it('round-trips the header and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 250, 255]);
    const buffer = encodeSwarmFrame({ requestId: 7, pos: 42, tokens: 3 }, payload);
    expect(buffer.byteLength).toBe(SWARM_FRAME_HEADER_BYTES + payload.byteLength);

    const decoded = decodeSwarmFrame(buffer);
    expect(decoded).not.toBeNull();
    expect(decoded!.header).toEqual({ requestId: 7, pos: 42, tokens: 3 });
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
  });

  it('rejects a truncated frame', () => {
    expect(decodeSwarmFrame(new ArrayBuffer(4))).toBeNull();
  });

  it('rejects a frame with the wrong magic', () => {
    const buffer = encodeSwarmFrame({ requestId: 1, pos: 0, tokens: 1 }, new Uint8Array([9]));
    new DataView(buffer).setUint16(0, SWARM_FRAME_MAGIC + 1, true);
    expect(decodeSwarmFrame(buffer)).toBeNull();
  });
});

describe('swarm message guards', () => {
  it('accepts a well-formed init message', () => {
    expect(
      isSwarmInitMessage({
        type: 'swarm-init',
        sessionId: 's',
        taskId: 't',
        model: 'm',
        layers: 8,
        index: 0,
        chainLength: 2,
        role: 'host',
        slice: { start: 0, end: 4, hasEmbed: true, hasHead: true },
      }),
    ).toBe(true);
  });

  it('rejects malformed init messages', () => {
    expect(isSwarmInitMessage(null)).toBe(false);
    expect(isSwarmInitMessage({ type: 'swarm-init', sessionId: 's' })).toBe(false);
    expect(
      isSwarmInitMessage({
        type: 'swarm-init', sessionId: 's', taskId: 't', model: 'm', layers: 0, index: 0, chainLength: 1,
        role: 'host', slice: { start: 0, end: 1, hasEmbed: true, hasHead: true },
      }),
    ).toBe(false);
  });

  it('accepts node messages and rejects unknown ones', () => {
    expect(isSwarmNodeMessage({ type: 'swarm-ready', sessionId: 's' })).toBe(true);
    expect(isSwarmNodeMessage({ type: 'swarm-token', sessionId: 's', token: 'hi' })).toBe(true);
    expect(isSwarmNodeMessage({ type: 'swarm-token', sessionId: 's' })).toBe(false);
    expect(isSwarmNodeMessage({ type: 'swarm-error', sessionId: 's' })).toBe(false);
    expect(isSwarmNodeMessage({ type: 'nope', sessionId: 's' })).toBe(false);
    expect(isSwarmNodeMessage({ type: 'swarm-ready' })).toBe(false);
  });
});
