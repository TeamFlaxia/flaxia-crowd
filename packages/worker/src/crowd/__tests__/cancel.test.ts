/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Tenant-scoped task cancellation at the `/crowd` API boundary.
 *
 * The Worker resolves the caller's tenant before the coordinator is touched;
 * the coordinator then uses that tenant as part of the storage key, so an id
 * owned by another tenant is indistinguishable from a missing task.
 */

import { env as testEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { crowdApp } from '../index';
import type { Env } from '../../index';

// Unique tenants: the Workers test pool shares Durable Object storage across
// test files, so these keys must not collide with other suites.
const API_KEYS = 'cancel-key-a:tenant-cancel-a,cancel-key-b:tenant-cancel-b';

function makeEnv(): Env {
  return { ...(testEnv as unknown as Env), API_KEYS };
}

async function submitTask(): Promise<string> {
  const res = await crowdApp.request('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cancel-key-a' },
    body: JSON.stringify({
      workload: 'ai-inference',
      payload: { task: 'text-generation', model: 'm', input: 'hi' },
    }),
  }, makeEnv());
  expect(res.status).toBe(200);
  return ((await res.json()) as { taskId: string }).taskId;
}

function cancel(taskId: string, apiKey?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return Promise.resolve(crowdApp.request(`/tasks/${taskId}/cancel`, { method: 'POST', headers }, makeEnv()));
}

describe('POST /crowd/tasks/:id/cancel', () => {
  it('requires an authenticated caller', async () => {
    expect((await cancel(crypto.randomUUID())).status).toBe(401);
  });

  it('rejects ids that fail the shared safe-id guard', async () => {
    expect((await cancel('bad,id', 'cancel-key-a')).status).toBe(400);
    expect((await cancel('a'.repeat(129), 'cancel-key-a')).status).toBe(400);
  });

  it('does not cancel another tenant\'s task and settles its own permanently', async () => {
    const taskId = await submitTask();

    const foreign = await cancel(taskId, 'cancel-key-b');
    expect(foreign.status).toBe(404);

    const first = await cancel(taskId, 'cancel-key-a');
    expect(first.status).toBe(200);
    const record = await first.json() as {
      status: string;
      error?: string;
      retryCount?: number;
      completedAt?: number;
    };
    expect(record.status).toBe('failed');
    expect(record.error).toBe('cancelled_by_caller');
    expect(record.retryCount).toBe(0);

    // A terminal task is returned unchanged; a repeated cancel has no effect.
    const again = await cancel(taskId, 'cancel-key-a');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(record);
  });
});
