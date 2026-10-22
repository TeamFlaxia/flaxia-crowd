import { describe, expect, it } from 'vitest';
import {
  isNodeProtocolQuarantined,
  MAX_TRACKED_PROTOCOL_NODES,
  PROTOCOL_FAULT_WINDOW_MS,
  PROTOCOL_QUARANTINE_MS,
  recordProtocolViolation,
  type ProtocolTrustState,
} from '../protocol-trust';

describe('swarm protocol trust policy', () => {
  it('quarantines only after repeated authenticated faults and expires the exclusion', () => {
    const now = 100_000;
    let state: ProtocolTrustState = {};
    state = recordProtocolViolation(state, 'host', 'invalid-swarm-plan', now).state;
    state = recordProtocolViolation(state, 'host', 'incomplete-swarm-plan', now + 1).state;
    expect(isNodeProtocolQuarantined(state, 'host', now + 1)).toBe(false);

    const third = recordProtocolViolation(state, 'host', 'invalid-swarm-plan', now + 2);
    state = third.state;
    expect(third.quarantineUntil).toBe(now + 2 + PROTOCOL_QUARANTINE_MS);
    expect(isNodeProtocolQuarantined(state, 'host', now + 3)).toBe(true);
    expect(isNodeProtocolQuarantined(state, 'host', now + PROTOCOL_QUARANTINE_MS + 3)).toBe(false);
  });

  it('drops expired/future faults and keeps only a bounded set of nodes and strikes', () => {
    const now = 1_000_000;
    const expired: ProtocolTrustState = {
      stale: { faults: [{ at: now - PROTOCOL_FAULT_WINDOW_MS - 1, kind: 'invalid-swarm-plan' }], quarantineUntil: 0, lastFaultAt: now },
      future: { faults: [{ at: now + 1, kind: 'invalid-swarm-plan' }], quarantineUntil: 0, lastFaultAt: now },
    };
    let state = recordProtocolViolation(expired, 'current', 'invalid-swarm-plan', now).state;
    for (let i = 0; i < MAX_TRACKED_PROTOCOL_NODES + 10; i++) {
      state = recordProtocolViolation(state, `n${i}`, 'invalid-swarm-plan', now + i + 1).state;
    }
    expect(Object.keys(state)).toHaveLength(MAX_TRACKED_PROTOCOL_NODES);
    expect(state.stale).toBeUndefined();
    expect(state.future).toBeUndefined();
    // The bound evicts oldest, non-quarantined entries first, including `current`.
    expect(Object.keys(state).some((nodeId) => nodeId === 'current')).toBe(false);
  });
  it('treats node ids as data even when they match special object property names', () => {
    let state: ProtocolTrustState = {};
    for (let i = 0; i < 3; i++) {
      state = recordProtocolViolation(state, '__proto__', 'invalid-swarm-plan', 10_000 + i).state;
    }
    expect(isNodeProtocolQuarantined(state, '__proto__', 10_003)).toBe(true);
  });
});
