import { describe, expect, it } from 'vitest';
import type { SwarmPeerQualityReport } from '@flaxia/sdk';
import { getPeerLinkCost, planSparseSwarmMesh } from '../mesh-planner';
import { mergePeerLinkHistory, type PeerLinkHistory } from '../peer-link-history';

function report(peerNodeId: string, sampledAt: number, appRtt: number | null, rtcRtt: number | null, rate: number | null): SwarmPeerQualityReport {
  const metric = (value: number | null) => ({ value, sampledAt, sampleCount: value === null ? 0 : 1 });
  const values = (rtt: number | null) => ({
    rttMs: metric(rtt), jitterMs: metric(null), sendMbps: metric(rate), receiveMbps: metric(rate),
  });
  return {
    version: 1,
    peerNodeId,
    sampledAt,
    expiresAt: sampledAt + 60_000,
    webRtc: values(rtcRtt),
    application: values(appRtt),
  };
}

function historyWith(now: number, observations: Array<{ from: string; to: string; rtt: number; rate: number | null }>): PeerLinkHistory {
  let history: PeerLinkHistory = {};
  for (const observation of observations) {
    history = mergePeerLinkHistory(history, observation.from,
      [report(observation.to, now, observation.rtt, null, observation.rate)], new Set([observation.to]), now).history;
  }
  return history;
}

describe('sparse peer mesh planner', () => {
  it('stores only fresh reports from current adjacent peers and caps history', () => {
    const now = 70_000;
    const stale = mergePeerLinkHistory(undefined, 'host', [report('stale', 0, 10, null, 10)], new Set(['stale']), now);
    expect(stale.accepted).toBe(0);

    let history: PeerLinkHistory = {};
    for (let index = 0; index < 270; index++) {
      history = mergePeerLinkHistory(history, `n${index}`, [report(`peer${index}`, now, 10, null, 10)], new Set([`peer${index}`]), now).history;
    }
    expect(Object.keys(history)).toHaveLength(256);
    expect(history['n269>peer269']).toBeDefined();
    expect(history['n0>peer0']).toBeUndefined();
  });

  it('keeps the resource-ranked host and selects the lowest RTT/bandwidth cost peer', () => {
    const now = 70_000;
    const history = historyWith(now, [
      { from: 'host', to: 'fast-peer', rtt: 20, rate: 100 },
      { from: 'host', to: 'slow-peer', rtt: 150, rate: 1 },
    ]);
    const link = getPeerLinkCost(history, 'host', 'fast-peer', now)!;

    expect(link.rttMs).toBe(20);
    expect(link.score).toBe(21);
    expect(planSparseSwarmMesh(['host', 'slow-peer', 'fast-peer'], 2, history, now)).toEqual(['host', 'fast-peer']);
  });

  it('preserves resource order for unknown, expired, unreachable, or too-narrow links', () => {
    const now = 70_000;
    const expired = historyWith(0, [{ from: 'host', to: 'peer', rtt: 1, rate: 100 }]);
    const unreachable = historyWith(now, [{ from: 'host', to: 'peer', rtt: 900, rate: 100 }]);
    const narrow = historyWith(now, [{ from: 'host', to: 'peer', rtt: 10, rate: 0.01 }]);
    expect(planSparseSwarmMesh(['host', 'second', 'peer'], 2, {}, now)).toEqual(['host', 'second']);
    expect(planSparseSwarmMesh(['host', 'peer'], 2, expired, now)).toEqual(['host', 'peer']);
    expect(planSparseSwarmMesh(['host', 'peer'], 2, unreachable, now)).toEqual(['host', 'peer']);
    expect(planSparseSwarmMesh(['host', 'peer'], 2, narrow, now)).toEqual(['host', 'peer']);
  });

  it('caps the measured candidate prefix and maximum mesh size', () => {
    const candidates = Array.from({ length: 100 }, (_, index) => `n${index}`);
    expect(planSparseSwarmMesh(candidates, 100, {}, 0)).toHaveLength(16);
    expect(planSparseSwarmMesh(candidates, 4, {}, 0)).toEqual(['n0', 'n1', 'n2', 'n3']);
  });
});
