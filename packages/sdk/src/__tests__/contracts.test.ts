import { describe, it, expect } from 'vitest';
import {
  WORKLOAD_TYPES,
  ROUTABLE_WORKLOADS,
  HEAVY_WORKLOADS,
  DEFAULT_WORKLOAD_TIMEOUT_MS,
  isWorkloadType,
  isRoutableWorkload,
  isHeavyWorkload,
  defaultTimeoutFor,
} from '../workloads';
import {
  parseCrowdWebhook,
  extractCallbackOutput,
  buildCallbackUrl,
  callbackTypeFromUrl,
  isTerminalTask,
} from '../webhook';
import { resolveNsfwTags } from '../nsfw';
import type { NudeNetDetection } from '../types';

describe('workloads', () => {
  it('exposes every workload type at runtime', () => {
    expect(WORKLOAD_TYPES).toContain('nudenet');
    expect(WORKLOAD_TYPES).toContain('vector-embed');
    expect(WORKLOAD_TYPES).toContain('moe-inference');
    expect(WORKLOAD_TYPES).toContain('swarm-inference');
    expect(new Set(WORKLOAD_TYPES).size).toBe(WORKLOAD_TYPES.length);
  });

  it('narrows untrusted values', () => {
    expect(isWorkloadType('nudenet')).toBe(true);
    expect(isWorkloadType('moe-inference')).toBe(true);
    expect(isWorkloadType('swarm-inference')).toBe(true);
    expect(isWorkloadType('not-a-workload')).toBe(false);
    expect(isWorkloadType(42)).toBe(false);
  });

  it('only treats implemented workloads as routable', () => {
    expect(ROUTABLE_WORKLOADS).not.toContain('moe-inference');
    expect(ROUTABLE_WORKLOADS).toContain('swarm-inference');
    expect(isRoutableWorkload('nudenet')).toBe(true);
    expect(isRoutableWorkload('moe-inference')).toBe(false);
    expect(isRoutableWorkload('swarm-inference')).toBe(true);
  });

  it('classifies heavy workloads', () => {
    expect(isHeavyWorkload('nudenet')).toBe(true);
    expect(isHeavyWorkload('swarm-inference')).toBe(true);
    expect(isHeavyWorkload('vector-store')).toBe(false);
    expect(HEAVY_WORKLOADS.has('moe-inference')).toBe(false);
  });

  it('provides a default timeout for every workload', () => {
    for (const workload of WORKLOAD_TYPES) {
      expect(defaultTimeoutFor(workload)).toBe(DEFAULT_WORKLOAD_TIMEOUT_MS[workload]);
      expect(defaultTimeoutFor(workload)).toBeGreaterThan(0);
    }
  });

  it('gives swarm inference room for a cold model download', () => {
    expect(defaultTimeoutFor('swarm-inference')).toBeGreaterThan(defaultTimeoutFor('ai-inference'));
  });
});

describe('webhook', () => {
  it('parses a done event', () => {
    const event = parseCrowdWebhook({ taskId: 't1', status: 'done', result: { output: { ok: true } } });
    expect(event).toEqual({ taskId: 't1', status: 'done', result: { output: { ok: true } } });
  });

  it('parses a failed event', () => {
    const event = parseCrowdWebhook({ taskId: 't2', status: 'failed', error: 'boom' });
    expect(event).toEqual({ taskId: 't2', status: 'failed', error: 'boom' });
  });

  it('rejects malformed payloads', () => {
    expect(parseCrowdWebhook(null)).toBeNull();
    expect(parseCrowdWebhook({})).toBeNull();
    expect(parseCrowdWebhook({ taskId: '', status: 'done' })).toBeNull();
    expect(parseCrowdWebhook({ taskId: 't', status: 'pending' })).toBeNull();
  });

  it('extracts output with output-first fallback', () => {
    expect(extractCallbackOutput({ taskId: 't', status: 'done', result: { output: { v: 1 } } })).toEqual({ v: 1 });
    expect(extractCallbackOutput({ taskId: 't', status: 'done', result: { v: 2 } })).toEqual({ v: 2 });
    expect(extractCallbackOutput({ taskId: 't', status: 'failed' })).toBeUndefined();
  });

  it('builds callback URLs with discriminator and params', () => {
    const url = buildCallbackUrl({
      baseUrl: 'https://flaxia.app/',
      type: 'nsfw',
      params: { postId: 'p1', ignored: undefined },
    });
    expect(url).toBe('https://flaxia.app/api/crowd/webhook?type=nsfw&postId=p1');
    expect(callbackTypeFromUrl(url)).toBe('nsfw');
  });

  it('supports custom callback paths', () => {
    const url = buildCallbackUrl({ baseUrl: 'https://host', path: 'hooks/crowd', type: 'vector-embed' });
    expect(url).toBe('https://host/hooks/crowd?type=vector-embed');
  });

  it('detects terminal tasks', () => {
    expect(isTerminalTask({ status: 'done' })).toBe(true);
    expect(isTerminalTask({ status: 'failed' })).toBe(true);
    expect(isTerminalTask({ status: 'processing' })).toBe(false);
  });
});

describe('resolveNsfwTags', () => {
  const det = (label: string, score: number): NudeNetDetection => ({ label, score, box: [0, 0, 1, 1] });

  it('returns nothing for empty detections', () => {
    expect(resolveNsfwTags(undefined)).toEqual({ nsfw: false, tags: [] });
    expect(resolveNsfwTags([])).toEqual({ nsfw: false, tags: [] });
  });

  it('flags explicit labels as nsfw', () => {
    const result = resolveNsfwTags([det('FEMALE_GENITALIA_EXPOSED', 0.98)]);
    expect(result.nsfw).toBe(true);
    expect(result.tags).toContain('exposed_genital');
    expect(result.tags).toContain('nsfw');
  });

  it('maps non-explicit labels to tags without nsfw', () => {
    const result = resolveNsfwTags([det('FEMALE_BREAST_EXPOSED', 0.7)]);
    expect(result.nsfw).toBe(false);
    expect(result.tags).toEqual(['exposed_breast']);
  });

  it('ignores detections below the threshold', () => {
    expect(resolveNsfwTags([det('FEMALE_GENITALIA_EXPOSED', 0.2)])).toEqual({ nsfw: false, tags: [] });
  });

  it('deduplicates tags', () => {
    const result = resolveNsfwTags([det('MALE_GENITALIA_EXPOSED', 0.9), det('FEMALE_GENITALIA_EXPOSED', 0.8)]);
    expect(result.tags.filter((t) => t === 'exposed_genital')).toHaveLength(1);
  });
});