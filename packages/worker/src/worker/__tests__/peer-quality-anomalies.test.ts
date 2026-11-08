import { describe, expect, it } from 'vitest';
import {
  findPeerRttDisagreements,
  MAX_PEER_QUALITY_ANOMALIES,
  mergePeerRttDisagreementLog,
} from '../peer-quality-anomalies';
import type { SwarmPeerQualityReport } from '@flaxia/sdk';

function report(overrides: Partial<SwarmPeerQualityReport> = {}, now = 100_000): SwarmPeerQualityReport {
  const metric = (value: number | null, sampleCount = value === null ? 0 : 5) => ({ value, sampledAt: now, sampleCount });
  const values = (rttMs: number | null) => ({
    rttMs: metric(rttMs), jitterMs: metric(null), sendMbps: metric(null), receiveMbps: metric(null),
  });
  return {
    version: 1,
    peerNodeId: 'peer',
    sampledAt: now,
    expiresAt: now + 30_000,
    webRtc: values(50),
    application: values(2_500),
    ...overrides,
  };
}

describe('peer RTT disagreement diagnostics', () => {
  it('records only large differences from fresh multi-sample adjacent links', () => {
    const now = 100_000;
    const anomaly = report({}, now);
    const unrelated = report({ peerNodeId: 'not-adjacent' }, now);
    const insufficient = report({
      application: { ...anomaly.application, rttMs: { value: 2_500, sampledAt: now, sampleCount: 1 } },
    }, now);
    const records = findPeerRttDisagreements('node-a', [anomaly, unrelated, insufficient], new Set(['peer']), now);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      reporterNodeId: 'node-a', peerNodeId: 'peer', webRtcRttMs: 50, applicationRttMs: 2_500, differenceMs: 2_450,
    });
  });

  it('keeps the audit log bounded and expires old observations', () => {
    const now = 1_000_000;
    const additions = Array.from({ length: MAX_PEER_QUALITY_ANOMALIES + 3 }, (_, i) => ({
      reporterNodeId: `n${i}`,
      peerNodeId: 'peer',
      webRtcRttMs: 50,
      applicationRttMs: 2_500,
      differenceMs: 2_450,
      sampledAt: now,
      detectedAt: now,
    }));
    const state = mergePeerRttDisagreementLog([
      { ...additions[0], detectedAt: now - 10 * 60_000 - 1 },
      { ...additions[0], detectedAt: now + 1 },
    ], additions, now);
    expect(state).toHaveLength(MAX_PEER_QUALITY_ANOMALIES);
    expect(state[0].reporterNodeId).toBe('n3');
  });
});
