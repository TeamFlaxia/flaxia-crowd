import { isSwarmPeerQualityReport, type SwarmPeerQualityReport } from '@flaxia/sdk';

export const PEER_LINK_HISTORY_TTL_MS = 60_000;
export const MAX_PEER_LINK_HISTORY_ENTRIES = 256;

export interface PeerLinkObservation {
  fromNodeId: string;
  toNodeId: string;
  sampledAt: number;
  expiresAt: number;
  applicationRttMs: number | null;
  webRtcRttMs: number | null;
  bandwidthMbps: number | null;
}

export type PeerLinkHistory = Record<string, PeerLinkObservation>;

export function peerLinkKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}>${toNodeId}`;
}

function observedRate(report: SwarmPeerQualityReport): number | null {
  const send = report.application.sendMbps.value;
  const receive = report.application.receiveMbps.value;
  if (send !== null && receive !== null) return Math.min(send, receive);
  return send ?? receive;
}

/** Keep only authenticated, current-session adjacent reports in a bounded short-lived history. */
export function mergePeerLinkHistory(
  current: PeerLinkHistory | undefined,
  reporterNodeId: string,
  reports: unknown[],
  adjacentNodeIds: ReadonlySet<string>,
  now: number,
  maxEntries = MAX_PEER_LINK_HISTORY_ENTRIES,
): { history: PeerLinkHistory; accepted: number } {
  const history: PeerLinkHistory = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (value && value.expiresAt > now && now - value.sampledAt <= PEER_LINK_HISTORY_TTL_MS &&
        value.fromNodeId && value.toNodeId && key === peerLinkKey(value.fromNodeId, value.toNodeId)) {
      history[key] = value;
    }
  }

  let accepted = 0;
  for (const value of reports) {
    if (!isSwarmPeerQualityReport(value, now) || !adjacentNodeIds.has(value.peerNodeId) ||
        value.peerNodeId === reporterNodeId) continue;
    const applicationRttMs = value.application.rttMs.value;
    const webRtcRttMs = value.webRtc.rttMs.value;
    // RTT is required for scheduling. Bandwidth without an RTT sample is kept
    // out of the mesh history so an unknown link is never treated as fast.
    if (applicationRttMs === null && webRtcRttMs === null) continue;
    const observation: PeerLinkObservation = {
      fromNodeId: reporterNodeId,
      toNodeId: value.peerNodeId,
      sampledAt: value.sampledAt,
      expiresAt: Math.min(value.expiresAt, value.sampledAt + PEER_LINK_HISTORY_TTL_MS),
      applicationRttMs,
      webRtcRttMs,
      bandwidthMbps: observedRate(value),
    };
    history[peerLinkKey(reporterNodeId, value.peerNodeId)] = observation;
    accepted++;
  }

  const entries = Object.entries(history).sort((a, b) => a[1].sampledAt - b[1].sampledAt);
  const cap = Math.max(1, Math.min(MAX_PEER_LINK_HISTORY_ENTRIES, Math.floor(maxEntries)));
  for (const [key] of entries.slice(0, Math.max(0, entries.length - cap))) delete history[key];
  return { history, accepted };
}
