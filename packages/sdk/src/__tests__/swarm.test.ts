import { describe, it, expect } from 'vitest';
import type { SwarmSessionPlan } from '../types';
import {
  planSwarmLayers,
  buildSwarmChain,
  swarmChainIndex,
  swarmNextHopIndex,
  encodeSwarmFrame,
  decodeSwarmFrame,
  encodeSwarmStopFrame,
  isSwarmStopFrame,
  isSwarmInitMessage,
  isSwarmNodeMessage,
  isSwarmSliceMessage,
  isSwarmStartMessage,
  isSwarmErrorMessage,
  isValidSwarmChain,
  isValidSwarmSlice,
  MAX_SWARM_LAYERS,
  MAX_SWARM_SLICE_LAYERS,
  SWARM_FRAME_MAGIC,
  SWARM_FRAME_HEADER_BYTES,
  encodeSwarmEnvelope,
  decodeSwarmEnvelope,
  computeSwarmFrameMac,
  signSwarmEnvelope,
  verifySwarmEnvelope,
  SWARM_ENVELOPE_MAC_BYTES,
} from '../swarm';

describe('swarm session envelopes', () => {
  it('preserves the session and binary frame', () => {
    const frame = encodeSwarmStopFrame();
    const decoded = decodeSwarmEnvelope(encodeSwarmEnvelope('attempt-2', frame));
    expect(decoded?.sessionId).toBe('attempt-2');
    expect(decoded?.frame).toEqual(frame);
  });

  it('rejects missing or truncated session envelopes', () => {
    expect(decodeSwarmEnvelope(new ArrayBuffer(0))).toBeNull();
    expect(decodeSwarmEnvelope(encodeSwarmStopFrame())).toBeNull();
    expect(decodeSwarmEnvelope(encodeSwarmEnvelope('s', encodeSwarmStopFrame()).slice(0, 8))).toBeNull();
  });

  it('round-trips a per-hop MAC and reports its absence', () => {
    const frame = encodeSwarmFrame({ requestId: 3, pos: 3, tokens: 1 }, new Uint8Array(4));
    const signed = encodeSwarmEnvelope('session-a', frame, new Uint8Array(SWARM_ENVELOPE_MAC_BYTES).fill(7));
    const decoded = decodeSwarmEnvelope(signed);
    expect(decoded?.mac?.byteLength).toBe(SWARM_ENVELOPE_MAC_BYTES);
    expect(decoded?.mac?.[0]).toBe(7);
    expect(decoded?.frame).toEqual(frame);

    const unsigned = decodeSwarmEnvelope(encodeSwarmEnvelope('session-a', frame));
    expect(unsigned?.mac).toBeNull();
  });

  it('rejects a MAC trailer with an unexpected length', () => {
    const frame = encodeSwarmStopFrame();
    const tampered = encodeSwarmEnvelope('s', frame, new Uint8Array(SWARM_ENVELOPE_MAC_BYTES));
    const view = new DataView(tampered);
    view.setUint8(4 + 1, 4); // session id length is 1, so the mac length lives here
    expect(decodeSwarmEnvelope(tampered)).toBeNull();
  });

  it('signs frames per hop and rejects the wrong key or a tampered frame', async () => {
    const frame = encodeSwarmFrame({ requestId: 1, pos: 1, tokens: 1 }, new Uint8Array([1, 2]));
    const signed = await signSwarmEnvelope('hop-key', 'session-a', frame);
    const decoded = decodeSwarmEnvelope(signed);
    expect(decoded?.mac?.byteLength).toBe(SWARM_ENVELOPE_MAC_BYTES);
    expect(await verifySwarmEnvelope('hop-key', 'session-a', decoded!.frame, decoded!.mac!)).toBe(true);
    expect(await verifySwarmEnvelope('other-key', 'session-a', decoded!.frame, decoded!.mac!)).toBe(false);
    expect(await verifySwarmEnvelope('hop-key', 'other-session', decoded!.frame, decoded!.mac!)).toBe(false);
    expect(await verifySwarmEnvelope('hop-key', 'session-a', decoded!.frame, new Uint8Array(4))).toBe(false);

    const tampered = decoded!.frame.slice(0);
    new Uint8Array(tampered)[SWARM_FRAME_HEADER_BYTES] ^= 0xff;
    expect(await verifySwarmEnvelope('hop-key', 'session-a', tampered, decoded!.mac!)).toBe(false);
  });

  it('computes a deterministic truncated MAC', async () => {
    const frame = encodeSwarmStopFrame();
    const first = await computeSwarmFrameMac('k', 's', frame);
    const second = await computeSwarmFrameMac('k', 's', frame);
    expect(first).toEqual(second);
    expect(first.byteLength).toBe(SWARM_ENVELOPE_MAC_BYTES);
  });
});

describe('swarm slice and control validators', () => {
  const slice = { start: 0, end: 4, hasEmbed: true, hasHead: true };

  it('accepts a well-formed slice message', () => {
    expect(
      isSwarmSliceMessage({
        type: 'swarm-slice',
        sessionId: 's',
        taskId: 't',
        model: 'qwen3.5-2b',
        timeoutMs: 1000,
        index: 0,
        chainLength: 2,
        role: 'host',
        slice,
        inboundKey: 'abc',
        outboundKey: 'def',
      }),
    ).toBe(true);
  });

  it('rejects a slice message whose bounds would materialise a whole model', () => {
    const base = {
      type: 'swarm-slice',
      sessionId: 's',
      taskId: 't',
      model: 'm',
      timeoutMs: 1000,
      index: 1,
      chainLength: 2,
      role: 'worker',
    };
    expect(isSwarmSliceMessage({ ...base, slice: { start: 0, end: 1e9, hasEmbed: false, hasHead: false } })).toBe(false);
    expect(
      isSwarmSliceMessage({
        ...base,
        slice: { start: 0, end: MAX_SWARM_SLICE_LAYERS + 1, hasEmbed: false, hasHead: false },
      }),
    ).toBe(false);
    expect(isSwarmSliceMessage({ ...base, slice: { start: 2, end: 2, hasEmbed: false, hasHead: false } })).toBe(false);
    expect(isSwarmSliceMessage({ ...base, slice: { start: -1, end: 2, hasEmbed: false, hasHead: false } })).toBe(false);
    expect(isSwarmSliceMessage({ ...base, index: 5, slice: { start: 0, end: 2, hasEmbed: false, hasHead: false } })).toBe(
      false,
    );
    expect(
      isSwarmSliceMessage({ ...base, role: 'host', slice: { start: 0, end: 2, hasEmbed: true, hasHead: true } }),
    ).toBe(false);
  });

  it('validates slices on their own', () => {
    expect(isValidSwarmSlice(slice)).toBe(true);
    expect(isValidSwarmSlice({ start: 0, end: 1e9, hasEmbed: true, hasHead: true })).toBe(false);
    expect(isValidSwarmSlice({ start: 1.5, end: 3, hasEmbed: true, hasHead: true })).toBe(false);
  });

  it('validates start and error messages', () => {
    expect(isSwarmStartMessage({ type: 'swarm-start', sessionId: 's', taskId: 't' })).toBe(true);
    expect(isSwarmStartMessage({ type: 'swarm-start', sessionId: 's' })).toBe(false);
    expect(isSwarmErrorMessage({ type: 'swarm-error', sessionId: 's', taskId: 't', error: 'boom' })).toBe(true);
    expect(isSwarmErrorMessage({ type: 'swarm-error', sessionId: 's', taskId: 't' })).toBe(false);
  });

  it('rejects a plan that hands a node an oversized slice', () => {
    expect(
      isValidSwarmChain([
        { nodeId: 'a', role: 'host', slice: { start: 0, end: 1e9, hasEmbed: true, hasHead: true } },
      ]),
    ).toBe(false);
    expect(
      isValidSwarmChain([
        { nodeId: 'a', role: 'host', slice: { start: 0, end: 2, hasEmbed: true, hasHead: true } },
        { nodeId: 'b', role: 'worker', slice: { start: 2, end: 4, hasEmbed: false, hasHead: false } },
      ]),
    ).toBe(true);
  });
});

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

  it('distinguishes stop frames from hidden frames', () => {
    const stop = encodeSwarmStopFrame(5);
    expect(isSwarmStopFrame(stop)).toBe(true);
    expect(decodeSwarmFrame(stop)).toBeNull();

    const hidden = encodeSwarmFrame({ requestId: 1, pos: 0, tokens: 1 }, new Uint8Array([1]));
    expect(isSwarmStopFrame(hidden)).toBe(false);
    expect(isSwarmStopFrame(new ArrayBuffer(4))).toBe(false);
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
        timeoutMs: 30_000,
        prompt: 'hi',
        members: [
          { nodeId: 'a', capacity: 4 },
          { nodeId: 'b', capacity: 2 },
        ],
      }),
    ).toBe(true);
  });

  it('rejects malformed init messages', () => {
    expect(isSwarmInitMessage(null)).toBe(false);
    expect(isSwarmInitMessage({ type: 'swarm-init', sessionId: 's' })).toBe(false);
    expect(
      isSwarmInitMessage({ type: 'swarm-init', sessionId: 's', taskId: 't', model: 'm', members: [] }),
    ).toBe(false);
    expect(
      isSwarmInitMessage({ type: 'swarm-init', sessionId: 's', taskId: 't', model: 'm', members: [{ nodeId: '' }] }),
    ).toBe(false);
    // The deadline and prompt are what the host's worker runs on: without them
    // the session would inherit an unbounded budget.
    expect(
      isSwarmInitMessage({
        type: 'swarm-init',
        sessionId: 's',
        taskId: 't',
        model: 'm',
        prompt: 'hi',
        members: [{ nodeId: 'a', capacity: 4 }],
      }),
    ).toBe(false);
    expect(
      isSwarmInitMessage({
        type: 'swarm-init',
        sessionId: 's',
        taskId: 't',
        model: 'm',
        timeoutMs: 1000,
        members: [{ nodeId: 'a', capacity: 4 }],
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

describe('isValidSwarmChain', () => {
  const valid = [
    { nodeId: 'a', role: 'host', slice: { start: 0, end: 6, hasEmbed: true, hasHead: true } },
    { nodeId: 'b', role: 'worker', slice: { start: 6, end: 8, hasEmbed: false, hasHead: false } },
  ];

  it('accepts a contiguous chain that covers every layer', () => {
    expect(isValidSwarmChain(valid)).toBe(true);
  });

  it('rejects gaps, overlaps and empty slices', () => {
    // gap: second slice must start where the first ended
    expect(isValidSwarmChain([valid[0], { ...valid[1], slice: { start: 7, end: 8, hasEmbed: false, hasHead: false } }])).toBe(false);
    // overlap
    expect(isValidSwarmChain([valid[0], { ...valid[1], slice: { start: 5, end: 8, hasEmbed: false, hasHead: false } }])).toBe(false);
    // empty slice
    expect(isValidSwarmChain([{ ...valid[0], slice: { start: 0, end: 0, hasEmbed: true, hasHead: true } }])).toBe(false);
  });

  it('requires the first entry to own the embedding and head', () => {
    expect(isValidSwarmChain([{ ...valid[0], slice: { ...valid[0].slice, hasEmbed: false } }, valid[1]])).toBe(false);
    expect(isValidSwarmChain([valid[0], { ...valid[1], role: 'host' }])).toBe(false);
  });

  it('rejects empty or malformed input', () => {
    expect(isValidSwarmChain([])).toBe(false);
    expect(isValidSwarmChain('nope')).toBe(false);
    expect(isValidSwarmChain([{ nodeId: 'a' }])).toBe(false);
  });

  it('rejects slices beyond the accepted layer bounds', () => {
    // A hostile host assigning a volunteer the whole model (and then some):
    // the node would expand it into GPU memory and OOM.
    expect(isValidSwarmChain([
      valid[0],
      { ...valid[1], slice: { start: 6, end: 1e9, hasEmbed: false, hasHead: false } },
    ])).toBe(false);

    // Non-integer layer indices are not a plan.
    expect(isValidSwarmChain([
      { ...valid[0], slice: { start: 0, end: 2.5, hasEmbed: true, hasHead: true } },
    ])).toBe(false);

    // No single node may be asked for more than MAX_SWARM_SLICE_LAYERS.
    expect(isValidSwarmChain([
      { ...valid[0], slice: { start: 0, end: MAX_SWARM_SLICE_LAYERS + 1, hasEmbed: true, hasHead: true } },
    ])).toBe(false);

    // Nor may the model be deeper than MAX_SWARM_LAYERS.
    expect(isValidSwarmChain([
      { ...valid[0], slice: { start: 0, end: MAX_SWARM_LAYERS + 1, hasEmbed: true, hasHead: true } },
    ])).toBe(false);
  });
});
