import { isSwarmPeerQualityReport, type SwarmPeerQualityReport } from '@flaxia/sdk';

/** Merge authenticated node reports into a bounded, TTL-checked link snapshot. */
export function mergePeerQualitySnapshot(
  current: Record<string, SwarmPeerQualityReport> | undefined,
  reporterNodeId: string,
  reports: unknown[],
  adjacentNodeIds: ReadonlySet<string>,
  now: number,
  maxEntries: number,
): { snapshot: Record<string, SwarmPeerQualityReport>; accepted: number } {
  const snapshot = { ...(current ?? {}) };
  for (const [key, report] of Object.entries(snapshot)) {
    if (!isSwarmPeerQualityReport(report, now)) delete snapshot[key];
  }

  let accepted = 0;
  for (const value of reports) {
    if (!isSwarmPeerQualityReport(value, now) || !adjacentNodeIds.has(value.peerNodeId)) continue;
    snapshot[`${reporterNodeId}:${value.peerNodeId}`] = value;
    accepted++;
  }

  const entries = Object.entries(snapshot);
  const cap = Math.max(1, maxEntries);
  if (entries.length > cap) {
    for (const [key] of entries.slice(0, entries.length - cap)) delete snapshot[key];
  }
  return { snapshot, accepted };
}
