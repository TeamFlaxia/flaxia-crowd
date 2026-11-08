/**
 * Bounded, short-lived measurements for one adjacent swarm peer. WebRTC
 * statistics and application-level estimates are deliberately separate:
 * they have different meanings and must not be combined by schedulers.
 */
export const SWARM_PEER_QUALITY_TTL_MS = 60_000;

export interface PeerQualityValue {
  /** A missing measurement is null; zero is a real measured value. */
  value: number | null;
  /** Wall-clock milliseconds for the underlying sample. */
  sampledAt: number;
  /** Number of raw samples represented by the smoothed value. */
  sampleCount: number;
}

export interface PeerQualityValues {
  rttMs: PeerQualityValue;
  jitterMs: PeerQualityValue;
  sendMbps: PeerQualityValue;
  receiveMbps: PeerQualityValue;
}

export interface SwarmPeerQualityReport {
  version: 1;
  peerNodeId: string;
  sampledAt: number;
  expiresAt: number;
  webRtc: PeerQualityValues;
  application: PeerQualityValues;
}

const MAX_METRIC_VALUE: Record<keyof PeerQualityValues, number> = {
  rttMs: 30_000,
  jitterMs: 30_000,
  sendMbps: 100_000,
  receiveMbps: 100_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validMetric(value: unknown, key: keyof PeerQualityValues, reportTime: number): value is PeerQualityValue {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.sampledAt) || Math.abs((value.sampledAt as number) - reportTime) > SWARM_PEER_QUALITY_TTL_MS) {
    return false;
  }
  if (!Number.isInteger(value.sampleCount) || (value.sampleCount as number) < 0 || (value.sampleCount as number) > 1000) {
    return false;
  }
  const sampleCount = value.sampleCount as number;
  if (value.value === null) return sampleCount === 0;
  return typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 &&
    value.value <= MAX_METRIC_VALUE[key] && sampleCount >= 1;
}

function validMetrics(value: unknown, reportTime: number): value is PeerQualityValues {
  if (!isRecord(value)) return false;
  return validMetric(value.rttMs, 'rttMs', reportTime) &&
    validMetric(value.jitterMs, 'jitterMs', reportTime) &&
    validMetric(value.sendMbps, 'sendMbps', reportTime) &&
    validMetric(value.receiveMbps, 'receiveMbps', reportTime);
}

/** Validate an untrusted quality report at the coordinator boundary. */
export function isSwarmPeerQualityReport(value: unknown, now = Date.now()): value is SwarmPeerQualityReport {
  if (!isRecord(value) || value.version !== 1 || typeof value.peerNodeId !== 'string' ||
      !value.peerNodeId || value.peerNodeId.length > 64) return false;
  if (!Number.isSafeInteger(value.sampledAt) || !Number.isSafeInteger(value.expiresAt)) return false;
  const sampledAt = value.sampledAt as number;
  const expiresAt = value.expiresAt as number;
  if (sampledAt > now + 5_000 || sampledAt < now - SWARM_PEER_QUALITY_TTL_MS ||
      expiresAt <= now || expiresAt <= sampledAt || expiresAt - sampledAt > SWARM_PEER_QUALITY_TTL_MS) return false;
  return validMetrics(value.webRtc, sampledAt) && validMetrics(value.application, sampledAt);
}
