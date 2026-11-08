import { describe, expect, it } from 'vitest';
import { isSwarmPeerQualityReport } from '@flaxia/sdk';
import {
  bytesPerSecondToMbps,
  createSwarmPeerQualityReport,
  smoothPeerQualitySamples,
} from '../peer-quality';

describe('swarm peer quality measurements', () => {
  it('uses a bounded median window and ignores an isolated high spike', () => {
    expect(smoothPeerQualitySamples([32, 34, 31, 1000])).toEqual([32, 34, 31]);
    const report = createSwarmPeerQualityReport('peer-b', 10_000, { rttMs: [32, 34, 31, 1000] }, {});
    expect(report.webRtc.rttMs).toEqual({ value: 32, sampledAt: 10_000, sampleCount: 3 });
    expect(report.application.rttMs).toEqual({ value: null, sampledAt: 10_000, sampleCount: 0 });
  });

  it('converts application byte counter deltas to Mbps and rejects invalid intervals', () => {
    expect(bytesPerSecondToMbps(125_000, 1000)).toBe(1);
    expect(bytesPerSecondToMbps(1, 0)).toBeNull();
    expect(bytesPerSecondToMbps(-1, 1000)).toBeNull();
  });

  it('keeps unavailable metrics distinct from measured zero and enforces expiry', () => {
    const report = createSwarmPeerQualityReport('peer-b', 10_000, { rttMs: [0] }, {});
    expect(report.webRtc.rttMs.value).toBe(0);
    expect(report.application.rttMs.value).toBeNull();
    expect(isSwarmPeerQualityReport(report, 10_001)).toBe(true);
    expect(isSwarmPeerQualityReport({ ...report, expiresAt: 100_000 }, 10_001)).toBe(false);
    expect(isSwarmPeerQualityReport({ ...report, webRtc: { ...report.webRtc, sendMbps: { value: 2, sampledAt: 10_000, sampleCount: 0 } } }, 10_001)).toBe(false);
    expect(isSwarmPeerQualityReport(report, 70_001)).toBe(false);
  });
});
