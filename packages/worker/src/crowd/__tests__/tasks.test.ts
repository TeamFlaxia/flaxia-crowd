/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * `POST /crowd/tasks` boundary validation.
 *
 * Payload checks happen at submit time: a client that mistypes an option must
 * get a 400, not a task that quietly runs with different settings than it asked
 * for.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { crowdApp } from '../index';
import type { Env } from '../../index';

const API_KEY = 'test-api-key';

function envWithApiKey(apiKey: string): Env {
  return new Proxy(testEnv as unknown as Env, {
    get(target, prop, receiver) {
      if (prop === 'API_KEYS') return apiKey;
      return Reflect.get(target as object, prop, receiver);
    },
  });
}

function submit(
  payload: unknown,
  workload = 'ai-inference',
  apiKey = API_KEY,
  options: { priority?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    crowdApp.request(
      '/tasks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ workload, payload, ...options }),
      },
      envWithApiKey(apiKey),
    ),
  );
}

describe('POST /tasks payload validation', () => {
  it('fails closed when the API_KEYS secret is not configured', async () => {
    const res = await submit({ task: 'text-generation', model: 'm', input: 'hi' }, 'ai-inference', '');
    expect(res.status).toBe(401);
  });

  it('accepts a well-formed ai-inference payload', async () => {
    const res = await submit({ task: 'text-generation', model: 'm', input: 'hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId?: string };
    expect(typeof body.taskId).toBe('string');
  });

  it('accepts a bounded scheduling priority', async () => {
    const res = await submit({ task: 'text-generation', model: 'm', input: 'hi' }, 'ai-inference', API_KEY, { priority: 3 });
    expect(res.status).toBe(200);
  });

  it.each([-1, 1.5, 4, '2', null])('rejects invalid scheduling priority %s', async (priority) => {
    const res = await submit({ task: 'text-generation', model: 'm', input: 'hi' }, 'ai-inference', API_KEY, { priority });
    expect(res.status).toBe(400);
  });

  const invalid: Array<[label: string, payload: unknown]> = [
    ['a non-object payload', 'nope'],
    ['an unknown engine', { task: 'text-generation', model: 'm', input: 'hi', engine: 'other' }],
    ['a non-boolean ondeviceOnly', { task: 'text-generation', model: 'm', input: 'hi', options: { ondeviceOnly: 'yes' } }],
  ];

  it.each(invalid)('rejects %s with 400', async (_label, payload) => {
    const res = await submit(payload);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it('still rejects an unroutable workload before payload validation', async () => {
    const res = await submit({ task: 'text-generation' }, 'moe-inference');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Invalid workload type');
  });

  it('exposes only the authenticated tenant queue statistics', async () => {
    const unauthorized = await crowdApp.request('/queue/stats', {}, envWithApiKey(API_KEY));
    expect(unauthorized.status).toBe(401);

    const response = await crowdApp.request('/queue/stats', {
      headers: { Authorization: `Bearer ${API_KEY}` },
    }, envWithApiKey(API_KEY));
    expect(response.status).toBe(200);
    const stats = await response.json() as { pendingCount?: number; pendingByPriority?: Record<string, number> };
    expect(typeof stats.pendingCount).toBe('number');
    expect(stats.pendingByPriority).toMatchObject({ 0: expect.any(Number), 1: expect.any(Number), 2: expect.any(Number), 3: expect.any(Number) });
  });
});
