import { peerLinkKey, type PeerLinkHistory } from './peer-link-history';

export const MAX_MESH_CANDIDATES = 32;
export const MAX_MESH_NODES = 16;
export const MAX_SCHEDULABLE_PEER_RTT_MS = 800;
export const MIN_SCHEDULABLE_PEER_BANDWIDTH_MBPS = 0.1;
/** Adds 100 ms per Mbps inverse to avoid selecting a narrow link on RTT alone. */
export const BANDWIDTH_COST_FACTOR_MS = 100;

export interface PeerLinkCost {
  rttMs: number;
  bandwidthMbps: number | null;
  score: number;
}

/**
 * Prefer app-level RTT when available, otherwise use WebRTC RTT; never average
 * the two measurement sources. Expired, unreachable, and too-narrow links are
 * treated as unknown so the resource-ranked fallback remains available.
 */
export function getPeerLinkCost(
  history: PeerLinkHistory,
  leftNodeId: string,
  rightNodeId: string,
  now: number,
): PeerLinkCost | null {
  const observations = [
    history[peerLinkKey(leftNodeId, rightNodeId)],
    history[peerLinkKey(rightNodeId, leftNodeId)],
  ].filter((value) => value && value.expiresAt > now && now - value.sampledAt <= 60_000);
  if (!observations.length) return null;

  const applicationRtts = observations.map((value) => value.applicationRttMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const rtts = applicationRtts.length
    ? applicationRtts
    : observations.map((value) => value.webRtcRttMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!rtts.length) return null;
  const rttMs = rtts.reduce((sum, value) => sum + value, 0) / rtts.length;
  if (rttMs > MAX_SCHEDULABLE_PEER_RTT_MS) return null;

  const rates = observations.map((value) => value.bandwidthMbps)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const bandwidthMbps = rates.length ? Math.min(...rates) : null;
  if (bandwidthMbps !== null && bandwidthMbps < MIN_SCHEDULABLE_PEER_BANDWIDTH_MBPS) return null;

  return {
    rttMs,
    bandwidthMbps,
    score: rttMs + (bandwidthMbps === null ? 0 : BANDWIDTH_COST_FACTOR_MS / bandwidthMbps),
  };
}

/**
 * Pick a small set from the resource-ranked prefix, then arrange its ring by
 * measured peer link cost. With no fresh usable edges, preserve resource order.
 */
export function planSparseSwarmMesh(
  rankedNodeIds: readonly string[],
  maxNodes: number,
  history: PeerLinkHistory,
  now: number,
): string[] {
  const candidates = rankedNodeIds.slice(0, MAX_MESH_CANDIDATES);
  const count = Math.max(0, Math.min(MAX_MESH_NODES, Math.floor(maxNodes), candidates.length));
  if (count <= 1) return candidates.slice(0, count);

  const selected = [candidates[0]];
  const remaining = new Set(candidates.slice(1));
  while (selected.length < count && remaining.size) {
    const ranked = [...remaining].map((nodeId) => {
      const costs = selected.map((selectedId) => getPeerLinkCost(history, nodeId, selectedId, now))
        .filter((cost): cost is PeerLinkCost => cost !== null);
      return {
        nodeId,
        measuredEdges: costs.length,
        averageCost: costs.length ? costs.reduce((sum, cost) => sum + cost.score, 0) / costs.length : Number.POSITIVE_INFINITY,
      };
    }).sort((a, b) => b.measuredEdges - a.measuredEdges || a.averageCost - b.averageCost ||
      candidates.indexOf(a.nodeId) - candidates.indexOf(b.nodeId));
    const next = ranked[0].nodeId;
    selected.push(next);
    remaining.delete(next);
  }

  // Keep the resource-ranked host first, then follow the lowest-cost known hop.
  // Unknown links use the original resource order as a deterministic fallback.
  const ring = [selected[0]];
  const unplaced = new Set(selected.slice(1));
  while (unplaced.size) {
    const last = ring[ring.length - 1];
    const next = [...unplaced].map((nodeId) => ({
      nodeId,
      cost: getPeerLinkCost(history, last, nodeId, now)?.score ?? Number.POSITIVE_INFINITY,
    })).sort((a, b) => a.cost - b.cost || candidates.indexOf(a.nodeId) - candidates.indexOf(b.nodeId))[0].nodeId;
    ring.push(next);
    unplaced.delete(next);
  }
  return ring;
}
