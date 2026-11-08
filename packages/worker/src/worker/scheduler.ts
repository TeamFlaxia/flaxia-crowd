export type PlacementReason =
  | 'only-eligible-candidate'
  | 'warm-model'
  | 'measured-gpu'
  | 'known-capacity'
  | 'reported-load'
  | 'assignment-count'
  | 'stable-order';

/** Coordinator-side summary used to explain why one eligible node was picked. */
export interface PlacementCandidate {
  nodeId: string;
  warmModel: boolean;
  /** Fresh measured probe latency, or null when unavailable/expired. */
  gpuCompletionMs: number | null;
  /** Known memory capacity hint, or null when unknown. */
  capacityBytes: number | null;
  /** Fresh reported load in [0, 1], or null when unavailable. */
  cpuLoad: number | null;
  assignedCount: number;
  connectedAt: number;
}

export interface RankedPlacement {
  candidate: PlacementCandidate;
  reason: PlacementReason;
}

/**
 * Rank only eligible nodes. Node reports remain advisory: this function never
 * treats a claimed value as authorization or a hard memory guarantee.
 */
export function rankPlacementCandidates(candidates: PlacementCandidate[]): RankedPlacement[] {
  const ranked = [...candidates].sort((a, b) =>
    Number(b.warmModel) - Number(a.warmModel) ||
    (a.gpuCompletionMs ?? Number.POSITIVE_INFINITY) - (b.gpuCompletionMs ?? Number.POSITIVE_INFINITY) ||
    (b.capacityBytes ?? -1) - (a.capacityBytes ?? -1) ||
    a.assignedCount - b.assignedCount ||
    (a.cpuLoad ?? Number.POSITIVE_INFINITY) - (b.cpuLoad ?? Number.POSITIVE_INFINITY) ||
    a.connectedAt - b.connectedAt ||
    a.nodeId.localeCompare(b.nodeId),
  );

  return ranked.map((candidate, index) => ({
    candidate,
    reason: placementReason(candidate, ranked[index + 1]),
  }));
}

function placementReason(selected: PlacementCandidate, runnerUp?: PlacementCandidate): PlacementReason {
  if (!runnerUp) return 'only-eligible-candidate';
  if (selected.warmModel !== runnerUp.warmModel) return 'warm-model';
  if (selected.gpuCompletionMs !== null && selected.gpuCompletionMs !== runnerUp.gpuCompletionMs) return 'measured-gpu';
  if (selected.capacityBytes !== null && selected.capacityBytes !== runnerUp.capacityBytes) return 'known-capacity';
  if (selected.assignedCount !== runnerUp.assignedCount) return 'assignment-count';
  if (selected.cpuLoad !== null && selected.cpuLoad !== runnerUp.cpuLoad) return 'reported-load';
  return 'stable-order';
}

export interface NodeReservation {
  taskId: string;
  generation: string;
  expiresAt: number;
}

/** An expired reservation never blocks a new allocation. */
export function reservationBlocksAllocation(reservation: NodeReservation | undefined, now: number): boolean {
  return !!reservation && Number.isFinite(reservation.expiresAt) && reservation.expiresAt > now;
}

/** A stale cleanup may release only the reservation generation it observed. */
export function reservationMatches(
  reservation: NodeReservation | undefined,
  taskId: string,
  generation?: string,
): boolean {
  return !!reservation && reservation.taskId === taskId &&
    (generation === undefined || reservation.generation === generation);
}
