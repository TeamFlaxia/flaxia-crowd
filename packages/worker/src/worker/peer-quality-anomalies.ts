import { isSwarmPeerQualityReport } from '@flaxia/sdk';

export const PEER_QUALITY_ANOMALY_TTL_MS = 10 * 60_000;
export const MAX_PEER_QUALITY_ANOMALIES = 256;
export const MIN_RTT_DISAGREEMENT_MS = 1_000;
export const MIN_ANOMALOUS_RTT_MS = 2_000;
const MIN_RTT_SAMPLE_COUNT = 3;

/**
 * An operational diagnostic only. Both values are measurements reported by
 * the same authenticated browser and are not independent proof of misconduct.
 */
export interface PeerRttDisagreement {
  reporterNodeId: string;
  peerNodeId: string;
  webRtcRttMs: number;
  applicationRttMs: number;
  differenceMs: number;
  sampledAt: number;
  detectedAt: number;
}

export function findPeerRttDisagreements(
  reporterNodeId: string,
  reports: unknown[],
  adjacentNodeIds: ReadonlySet<string>,
  now: number,
): PeerRttDisagreement[] {
  const anomalies: PeerRttDisagreement[] = [];
  for (const value of reports) {
    if (!isSwarmPeerQualityReport(value, now) || !adjacentNodeIds.has(value.peerNodeId)) continue;
    const webRtc = value.webRtc.rttMs;
    const application = value.application.rttMs;
    if (webRtc.value === null || application.value === null ||
        webRtc.sampleCount < MIN_RTT_SAMPLE_COUNT || application.sampleCount < MIN_RTT_SAMPLE_COUNT) continue;
    const differenceMs = Math.abs(webRtc.value - application.value);
    if (differenceMs < MIN_RTT_DISAGREEMENT_MS || Math.max(webRtc.value, application.value) < MIN_ANOMALOUS_RTT_MS) continue;
    anomalies.push({
      reporterNodeId,
      peerNodeId: value.peerNodeId,
      webRtcRttMs: webRtc.value,
      applicationRttMs: application.value,
      differenceMs,
      sampledAt: value.sampledAt,
      detectedAt: now,
    });
  }
  return anomalies;
}

/** Keep a bounded, short-lived audit trail; never use it to penalize placement. */
export function mergePeerRttDisagreementLog(
  current: unknown,
  additions: PeerRttDisagreement[],
  now: number,
): PeerRttDisagreement[] {
  const recent = (Array.isArray(current) ? current : []).filter((value): value is PeerRttDisagreement =>
    !!value && typeof value === 'object' &&
    typeof value.reporterNodeId === 'string' && value.reporterNodeId.length <= 128 &&
    typeof value.peerNodeId === 'string' && value.peerNodeId.length <= 128 &&
    Number.isFinite(value.detectedAt) && value.detectedAt <= now && now - value.detectedAt <= PEER_QUALITY_ANOMALY_TTL_MS &&
    Number.isSafeInteger(value.sampledAt) &&
    Number.isFinite(value.webRtcRttMs) && Number.isFinite(value.applicationRttMs) &&
    Number.isFinite(value.differenceMs) && value.differenceMs >= MIN_RTT_DISAGREEMENT_MS,
  );
  return [...recent, ...additions].slice(-MAX_PEER_QUALITY_ANOMALIES);
}
