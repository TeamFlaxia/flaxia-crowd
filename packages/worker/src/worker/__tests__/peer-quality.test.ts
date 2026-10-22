import { describe, expect, it } from 'vitest';
import type { SwarmPeerQualityReport } from '@flaxia/sdk';
import { mergePeerQualitySnapshot } from '../peer-quality';

function qualityReport(peerNodeId: string, sampledAt: number, rtt?: number): SwarmPeerQualityReport {
  const value = (metric: number | undefined) => ({ value: metric ?? null, sampledAt, sampleCount: metric === undefined ? 0 : 1 });
  const metrics = { rttMs: value(rtt), jitterMs: value(undefined), sendMbps: value(undefined), receiveMbps: value(undefined) };
  return { version: 1, peerNodeId, sampledAt, expiresAt: sampledAt + 60_000, webRtc: metrics, application: metrics };
}

describe('Coordinator peer quality snapshot', () => {
  it('updates one adjacent link, ignores non-neighbors, and expires old samples', () => {
    const old = qualityReport('peer-b', 10_000, 25);
    const fresh = qualityReport('peer-b', 70_000, 40);
    const expired = qualityReport('peer-c', 0, 12);
    const result = mergePeerQualitySnapshot(
      { 'a:peer-b': old, 'a:peer-c': expired },
      'a',
      [fresh, qualityReport('outsider', 70_000, 1)],
      new Set(['peer-b']),
      70_000,
      4,
    );

    expect(result.accepted).toBe(1);
    expect(Object.keys(result.snapshot)).toEqual(['a:peer-b']);
    expect(result.snapshot['a:peer-b'].webRtc.rttMs.value).toBe(40);
  });

  it('keeps the snapshot within the configured edge cap', () => {
    const report = (peerNodeId: string) => qualityReport(peerNodeId, 20_000);
    const result = mergePeerQualitySnapshot(
      { 'x:a': report('a'), 'x:b': report('b'), 'x:c': report('c') },
      'x',
      [report('d')],
      new Set(['d']),
      20_000,
      2,
    );
    expect(Object.keys(result.snapshot)).toHaveLength(2);
    expect(result.snapshot['x:d']).toBeDefined();
  });
});
