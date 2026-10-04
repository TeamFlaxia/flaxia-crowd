/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `POST /crowd/tasks` boundary validation for `swarm-inference`.
 *
 * The scheduler falls back to defaults for unusable `swarm` options so a bad
 * payload cannot wedge the queue, but that fallback is a safety net, not an
 * API contract: a client that mistypes an option must get a 400, not a task
 * that quietly runs with different settings than it asked for.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { crowdApp } from '../index';
import type { Env } from '../../index';

const API_KEY = 'fc_live_flaxia_dev_key';

function submit(payload: unknown, workload = 'swarm-inference', ip?: string): Promise<Response> {
  return Promise.resolve(
    crowdApp.request(
      '/tasks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          ...(ip ? { 'CF-Connecting-IP': ip } : {}),
        },
        body: JSON.stringify({ workload, payload }),
      },
      testEnv as unknown as Env,
    ),
  );
}

describe('POST /tasks swarm payload validation', () => {
  it('accepts a payload without swarm options', async () => {
    const res = await submit({ model: 'qwen3-1.7b', prompt: 'hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId?: string };
    expect(typeof body.taskId).toBe('string');
  });

  it('accepts well-formed swarm options', async () => {
    const res = await submit({
      model: 'qwen3-1.7b',
      prompt: 'hi',
      maxNewTokens: 128,
      swarm: { minNodes: 2, maxNodes: 4, preferWarm: false },
    });
    expect(res.status).toBe(200);
  });

  const invalid: Array<[label: string, payload: unknown]> = [
    ['a non-object payload', 'nope'],
    ['a swarm option that is not an object', { model: 'm', prompt: 'p', swarm: 'abc' }],
    ['a swarm option that is an array', { model: 'm', prompt: 'p', swarm: [] }],
    ['a non-numeric minNodes', { model: 'm', prompt: 'p', swarm: { minNodes: 'abc' } }],
    ['a non-integer minNodes', { model: 'm', prompt: 'p', swarm: { minNodes: 2.5 } }],
    ['a zero minNodes', { model: 'm', prompt: 'p', swarm: { minNodes: 0 } }],
    ['a non-numeric maxNodes', { model: 'm', prompt: 'p', swarm: { maxNodes: { huge: true } } }],
    ['maxNodes below minNodes', { model: 'm', prompt: 'p', swarm: { minNodes: 4, maxNodes: 2 } }],
    ['a non-boolean preferWarm', { model: 'm', prompt: 'p', swarm: { preferWarm: 'yes' } }],
    ['a non-integer maxNewTokens', { model: 'm', prompt: 'p', maxNewTokens: 12.5 }],
    ['a zero maxNewTokens', { model: 'm', prompt: 'p', maxNewTokens: 0 }],
  ];

  it.each(invalid)('rejects %s with 400', async (_label, payload) => {
    const res = await submit(payload);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it('does not validate swarm options for other workloads', async () => {
    const res = await submit({ task: 'image-process', swarm: { minNodes: 'abc' } }, 'image-process');
    expect(res.status).toBe(200);
  });

  it('still rejects an unroutable workload before payload validation', async () => {
    const res = await submit({ swarm: { minNodes: 'abc' } }, 'moe-inference');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Invalid workload type');
  });
});

/**
 * The limiter itself lives in the Durable Object (the only shared storage the
 * worker has); these tests cover that the write routes go through it. Each test
 * uses its own client IP so the counters do not leak into the other cases.
 */
describe('write-route rate limiting', () => {
  const limit = parseInt((testEnv as unknown as Env).RATE_LIMIT_MAX || '100', 10);

  function register(ip: string, nodeId: string): Promise<Response> {
    const env = Object.assign({}, testEnv, { NODE_TOKEN_SECRET: 'test-node-secret' }) as unknown as Env;
    return Promise.resolve(
      crowdApp.request(
        '/nodes/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
          body: JSON.stringify({ siteId: 'site-1', nodeId, capabilities: ['ai-inference'] }),
        },
        env,
      ),
    );
  }

  it('returns 429 once POST /tasks exceeds the per-IP limit', async () => {
    const ip = '198.51.100.11';
    for (let i = 0; i < limit; i++) {
      const res = await submit({ model: 'qwen3-1.7b', prompt: 'hi' }, 'swarm-inference', ip);
      expect(res.status).toBe(200);
    }

    const limited = await submit({ model: 'qwen3-1.7b', prompt: 'hi' }, 'swarm-inference', ip);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it('returns 429 once POST /nodes/register exceeds the per-IP limit', async () => {
    const ip = '198.51.100.12';
    for (let i = 0; i < limit; i++) {
      const res = await register(ip, `node-${i}`);
      expect(res.status).toBe(200);
    }

    const limited = await register(ip, 'node-limited');
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});
