import {
  SWARM_PEER_QUALITY_TTL_MS,
  type PeerQualityValue,
  type PeerQualityValues,
  type SwarmPeerQualityReport,
} from '@flaxia/sdk';

export const SWARM_PEER_QUALITY_SAMPLE_INTERVAL_MS = 15_000;
export const SWARM_PEER_QUALITY_SAMPLE_WINDOW = 5;

/** Keep a short median window and ignore extreme high spikes before smoothing. */
export function smoothPeerQualitySamples(samples: readonly number[]): number[] {
  const finite = samples.filter((sample) => Number.isFinite(sample) && sample >= 0)
    .slice(-SWARM_PEER_QUALITY_SAMPLE_WINDOW);
  if (!finite.length) return [];
  const ordered = [...finite].sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)];
  const ceiling = median + Math.max(20, median * 4);
  return finite.filter((sample) => sample <= ceiling);
}

/** Convert counter deltas to decimal megabits per second. */
export function bytesPerSecondToMbps(bytes: number, elapsedMs: number): number | null {
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return (bytes * 8) / elapsedMs / 1000;
}

export function createPeerQualityValue(
  samples: readonly number[],
  sampledAt: number,
): PeerQualityValue {
  const accepted = smoothPeerQualitySamples(samples);
  if (!accepted.length) return { value: null, sampledAt, sampleCount: 0 };
  const ordered = [...accepted].sort((a, b) => a - b);
  return {
    value: ordered[Math.floor(ordered.length / 2)],
    sampledAt,
    sampleCount: accepted.length,
  };
}

export function createUnknownPeerQualityValues(sampledAt: number): PeerQualityValues {
  const unknown = (): PeerQualityValue => ({ value: null, sampledAt, sampleCount: 0 });
  return { rttMs: unknown(), jitterMs: unknown(), sendMbps: unknown(), receiveMbps: unknown() };
}

export function createSwarmPeerQualityReport(
  peerNodeId: string,
  sampledAt: number,
  webRtcSamples: Partial<Record<keyof PeerQualityValues, readonly number[]>>,
  applicationSamples: Partial<Record<keyof PeerQualityValues, readonly number[]>>,
  sampleTimes?: { webRtc: Partial<Record<keyof PeerQualityValues, number>>; application: Partial<Record<keyof PeerQualityValues, number>> },
): SwarmPeerQualityReport {
  const values = (samples: Partial<Record<keyof PeerQualityValues, readonly number[]>>,
    times?: Partial<Record<keyof PeerQualityValues, number>>): PeerQualityValues => {
    const value = (name: keyof PeerQualityValues) => {
      const time = times?.[name] ?? sampledAt;
      return sampledAt - time >= SWARM_PEER_QUALITY_TTL_MS
        ? createPeerQualityValue([], sampledAt)
        : createPeerQualityValue(samples[name] ?? [], time);
    };
    return { rttMs: value('rttMs'), jitterMs: value('jitterMs'), sendMbps: value('sendMbps'), receiveMbps: value('receiveMbps') };
  };
  return {
    version: 1,
    peerNodeId,
    sampledAt,
    expiresAt: sampledAt + SWARM_PEER_QUALITY_TTL_MS,
    webRtc: values(webRtcSamples, sampleTimes?.webRtc),
    application: values(applicationSamples, sampleTimes?.application),
  };
}
