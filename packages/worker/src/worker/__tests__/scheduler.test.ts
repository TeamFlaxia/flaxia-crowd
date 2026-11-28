import { describe, expect, it } from 'vitest';
import { rankPlacementCandidates, reservationBlocksAllocation, reservationMatches } from '../scheduler';

const candidate = (nodeId: string, overrides: Partial<Parameters<typeof rankPlacementCandidates>[0][number]> = {}) => ({
  nodeId,
  warmModel: false,
  warmBase: false,
  gpuCompletionMs: null,
  capacityBytes: null,
  cpuLoad: null,
  assignedCount: 0,
  connectedAt: 1,
  ...overrides,
});

describe('inference placement', () => {
  it('prefers a warm model, then fresh measured GPU speed and known capacity', () => {
    const ranked = rankPlacementCandidates([
      candidate('cold-fast', { gpuCompletionMs: 2, capacityBytes: 8_000 }),
      candidate('warm-slow', { warmModel: true, gpuCompletionMs: 20, capacityBytes: 2_000 }),
      candidate('cold-capacity', { gpuCompletionMs: 3, capacityBytes: 16_000 }),
    ]);

    expect(ranked.map(({ candidate: item }) => item.nodeId)).toEqual(['warm-slow', 'cold-fast', 'cold-capacity']);
    expect(ranked[0].reason).toBe('warm-model');
  });

  it('keeps unknown measurements distinct and uses assignment count as a tie break', () => {
    const ranked = rankPlacementCandidates([
      candidate('unknown', { assignedCount: 4 }),
      candidate('measured', { gpuCompletionMs: 12, capacityBytes: 1024, assignedCount: 9 }),
      candidate('measured-fast', { gpuCompletionMs: 4, capacityBytes: 1024, assignedCount: 9 }),
    ]);

    expect(ranked.map(({ candidate: item }) => item.nodeId)).toEqual(['measured-fast', 'measured', 'unknown']);
    expect(ranked[0].reason).toBe('measured-gpu');

    const warmth = rankPlacementCandidates([
      candidate('cold-fast', { gpuCompletionMs: 1, capacityBytes: 64_000 }),
      candidate('base-only', { warmBase: true, gpuCompletionMs: 40, capacityBytes: 1_000 }),
    ]);
    expect(warmth.map(({ candidate: item }) => item.nodeId)).toEqual(['base-only', 'cold-fast']);
    expect(warmth[0].reason).toBe('warm-base-model');

    const fullWarm = rankPlacementCandidates([
      candidate('base-only', { warmBase: true, gpuCompletionMs: 1, capacityBytes: 64_000 }),
      candidate('fully-warm', { warmModel: true, gpuCompletionMs: 40, capacityBytes: 1_000 }),
    ]);
    expect(fullWarm.map(({ candidate: item }) => item.nodeId)).toEqual(['fully-warm', 'base-only']);
    expect(fullWarm[0].reason).toBe('warm-model');

    const fairness = rankPlacementCandidates([
      candidate('more-assignments', { assignedCount: 9 }),
      candidate('fewer-assignments', { assignedCount: 4 }),
    ]);
    expect(fairness.map(({ candidate: item }) => item.nodeId)).toEqual(['fewer-assignments', 'more-assignments']);
    expect(fairness[0].reason).toBe('assignment-count');
  });
});

describe('reservation leases', () => {
  it('unblocks an expired lease and matches cleanup by task and generation', () => {
    const lease = { taskId: 'task-1', generation: 'attempt-2', expiresAt: 500 };
    expect(reservationBlocksAllocation(lease, 499)).toBe(true);
    expect(reservationBlocksAllocation(lease, 500)).toBe(false);
    expect(reservationMatches(lease, 'task-1', 'attempt-2')).toBe(true);
    expect(reservationMatches(lease, 'task-1', 'attempt-1')).toBe(false);
    expect(reservationMatches(lease, 'task-2', 'attempt-2')).toBe(false);
  });
});
