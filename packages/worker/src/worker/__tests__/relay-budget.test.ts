import { describe, expect, it } from 'vitest';
import {
  MAX_SWARM_RELAY_BYTES_PER_TASK,
  reserveSwarmRelayBytes,
  swarmRelayBudgetKey,
} from '../relay-budget';

describe('swarm relay byte budget', () => {
  it('allows a frame at the limit and rejects the next byte', () => {
    expect(reserveSwarmRelayBytes(MAX_SWARM_RELAY_BYTES_PER_TASK - 8, 8))
      .toBe(MAX_SWARM_RELAY_BYTES_PER_TASK);
    expect(reserveSwarmRelayBytes(MAX_SWARM_RELAY_BYTES_PER_TASK - 8, 9)).toBeNull();
  });

  it('fails closed on corrupt counters, empty frames, and unsafe sizes', () => {
    expect(reserveSwarmRelayBytes(Number.NaN, 1)).toBeNull();
    expect(reserveSwarmRelayBytes(0, 0)).toBeNull();
    expect(reserveSwarmRelayBytes(0, Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('uses a task-scoped key so retry attempts share one budget', () => {
    expect(swarmRelayBudgetKey('task-1')).toBe('swarm-relay-bytes:task-1');
  });
});
