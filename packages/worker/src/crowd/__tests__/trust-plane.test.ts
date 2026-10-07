/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Trust-plane regression tests for the `/crowd` API boundary:
 *
 *   #3  tenant isolation (per-key tenants, site allow-lists)
 *   #5  server-issued node identity, token-bound node ids, capacity clamps
 *   #6  swarm sizing / payload bounds
 *   #13 webhook signing fails closed
 *   #14 subscribe authorization
 *   #20 token transport via the WebSocket subprotocol
 *
 * These exercise `crowdApp` (the Worker route layer) rather than the Durable
 * Object directly, so the worker-level checks (token verification, tenant
 * resolution, subprotocol negotiation) are covered end to end.
 */

import { env as testEnv, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { crowdApp } from '../index';
import type { Env } from '../../index';
import { createNodeToken, createSubscribeToken, validateCallbackUrl, verifyNodeToken } from '../../security';
import {
  NODE_SIGNAL_PROTOCOL,
  SUBSCRIBE_PROTOCOL,
  buildNodeSignalProtocols,
  buildSubscribeProtocols,
} from '@flaxia/sdk';
import {
  TEST_NODE_TOKEN_SECRET,
  TEST_SUBSCRIBE_TOKEN_SECRET,
} from '../../worker/__tests__/testSecrets';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...(testEnv as unknown as Env), ...overrides };
}

function jsonRequest(body: unknown, apiKey: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  };
}

async function submitTask(apiKey: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  return crowdApp.request('/tasks', jsonRequest(body, apiKey), env);
}

async function getTask(apiKey: string, taskId: string, env: Env): Promise<Response> {
  return crowdApp.request(`/tasks/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` } }, env);
}

async function registerNode(env: Env, body: Record<string, unknown>): Promise<Response> {
  return crowdApp.request('/nodes/register', jsonRequest(body, 'ignored'), env);
}

function signalRequest(token: string | null, query = '', protocols?: string[]): RequestInit {
  const headers: Record<string, string> = { Upgrade: 'websocket', Connection: 'Upgrade' };
  if (protocols) headers['Sec-WebSocket-Protocol'] = protocols.join(', ');
  return { headers };
}

async function upgradeSignal(env: Env, token: string, extraQuery = ''): Promise<Response> {
  return crowdApp.request(
    `/signal${extraQuery}`,
    signalRequest(token, extraQuery, buildNodeSignalProtocols(token)),
    env,
  );
}

/** Read a node record from the shared coordinator DO. */
async function readNodeRecord(nodeId: string): Promise<Record<string, unknown> | undefined> {
  const stub = testEnv.COORDINATOR.get(testEnv.COORDINATOR.idFromName('global-coordinator'));
  return runInDurableObject(stub, (instance) =>
    (instance as any).ctx.storage.get(`node:${nodeId}`) as Promise<Record<string, unknown> | undefined>);
}

/** Read a task record straight out of the coordinator's tenant-scoped storage. */
async function readStoredTask(tenantId: string, taskId: string): Promise<Record<string, unknown> | undefined> {
  const stub = testEnv.COORDINATOR.get(testEnv.COORDINATOR.idFromName('global-coordinator'));
  return runInDurableObject(stub, (instance) =>
    (instance as any).ctx.storage.get(`task:${tenantId}:${taskId}`) as Promise<Record<string, unknown> | undefined>);
}

describe('#5 node identity is server-issued and token-bound', () => {
  it('accepts a registration without a site claim but cannot authenticate one', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { capabilities: ['ai-inference'] });
    expect(registered.status).toBe(200);
    const { token } = await registered.json() as { token: string };
    const payload = await verifyNodeToken(TEST_NODE_TOKEN_SECRET, token);
    expect(payload?.siteId).toBe('');
  });

  it('binds file-source support into the signed node token and coordinator record', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { siteId: 'flaxia', capabilities: ['container'], fileSources: true });
    expect(registered.status).toBe(200);
    const { token, nodeId } = await registered.json() as { token: string; nodeId: string };
    expect((await verifyNodeToken(TEST_NODE_TOKEN_SECRET, token))?.fileSources).toBe(true);

    const connected = await upgradeSignal(env, token);
    expect(connected.status).toBe(101);
    expect((await readNodeRecord(nodeId))?.fileSources).toBe(true);
    (connected as unknown as { webSocket?: WebSocket }).webSocket?.accept();
  });

  it('ignores a client-supplied nodeId and issues a fresh one', async () => {
    const env = makeEnv();
    const first = await registerNode(env, { siteId: 'example.com', nodeId: 'attacker-chosen' });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { nodeId: string; token: string };
    expect(firstBody.nodeId).not.toBe('attacker-chosen');
    expect(firstBody.token).toBeTruthy();

    // A second registration can never reuse an id: ids are always fresh, so a
    // node cannot register itself into someone else's identity.
    const second = await registerNode(env, { siteId: 'example.com', nodeId: firstBody.nodeId });
    const secondBody = await second.json() as { nodeId: string };
    expect(secondBody.nodeId).not.toBe(firstBody.nodeId);
  });

  it('rejects a tampered node token', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { siteId: 'example.com' });
    const { token } = await registered.json() as { token: string };
    const tampered = `${token.slice(0, -2)}xx`;
    const resp = await upgradeSignal(env, tampered);
    expect(resp.status).toBe(401);
  });

  it('binds the socket to the node id inside the token, not to a presented id', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { siteId: 'example.com' });
    const { token, nodeId } = await registered.json() as { token: string; nodeId: string };

    // A legacy client could try to present another node's id in the query
    // string; the worker overwrites it with the verified token's id.
    const resp = await upgradeSignal(env, token, '?nodeId=someone-else');
    expect(resp.status).toBe(101);
    expect(resp.headers.get('Sec-WebSocket-Protocol')).toBe(NODE_SIGNAL_PROTOCOL);

    const mine = await readNodeRecord(nodeId);
    expect(mine).toBeTruthy();
    expect(mine?.siteId).toBe('example.com');
    expect(await readNodeRecord('someone-else')).toBeUndefined();

    const socket = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    socket?.accept();
  });

  it('does not let a token be replayed as a different node', async () => {
    const env = makeEnv();
    // A token is a signed statement about one node id; re-signing it for another
    // id requires the secret, so a stolen token can only ever act as its owner.
    const stolen = await createNodeToken(TEST_NODE_TOKEN_SECRET, {
      siteId: 'victim.example',
      nodeId: 'victim-node',
      capabilities: ['ai-inference'],
      exp: Date.now() + 60_000,
    });
    const resp = await upgradeSignal(env, stolen, '?nodeId=attacker-node');
    expect(resp.status).toBe(101);
    expect(await readNodeRecord('victim-node')).toBeTruthy();
    expect(await readNodeRecord('attacker-node')).toBeUndefined();
    (resp as unknown as { webSocket?: WebSocket }).webSocket?.accept();
  });
});

describe('#20 token transport via the WebSocket subprotocol', () => {
  it('rejects a token in the query string', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { siteId: 'example.com' });
    const { token } = await registered.json() as { token: string };

    const resp = await crowdApp.request(
      `/signal?token=${encodeURIComponent(token)}`,
      signalRequest(null, '', buildNodeSignalProtocols(token)),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('requires the flaxia-node-v1 subprotocol with a bearer entry', async () => {
    const env = makeEnv();
    const registered = await registerNode(env, { siteId: 'example.com' });
    const { token } = await registered.json() as { token: string };

    expect((await crowdApp.request('/signal', signalRequest(null), env)).status).toBe(401);
    expect((await crowdApp.request('/signal', signalRequest(token, '', ['flaxia-node-v1']), env)).status).toBe(401);
    expect((await crowdApp.request('/signal', signalRequest(token, '', [`bearer.${token}`]), env)).status).toBe(401);
    expect(
      (await crowdApp.request('/signal', signalRequest(token, '', ['other-v1', `bearer.${token}`]), env)).status,
    ).toBe(401);
  });

  it('rejects a token in the subscribe query string', async () => {
    const env = makeEnv({ API_KEYS: 'key-sub-a:tenant-sub-a' });
    const submit = await submitTask('key-sub-a', { workload: 'ai-inference', payload: { task: 't' } }, env);
    const { taskId } = await submit.json() as { taskId: string };
    const token = await createSubscribeToken(TEST_SUBSCRIBE_TOKEN_SECRET, {
      tenantId: 'tenant-sub-a',
      taskId,
      exp: Date.now() + 60_000,
    });

    const resp = await crowdApp.request(
      `/subscribe?taskId=${taskId}&token=${encodeURIComponent(token)}`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Protocol': buildSubscribeProtocols(token).join(', '),
        },
      },
      env,
    );
    expect(resp.status).toBe(401);
  });
});

describe('#14 subscribe authorization', () => {
  const env = makeEnv({ API_KEYS: 'key-sub-owner:tenant-sub-owner,key-sub-other:tenant-sub-other' });

  it('issues a subscribe token with the submit response and accepts it', async () => {
    const submit = await submitTask('key-sub-owner', { workload: 'ai-inference', payload: { task: 't' } }, env);
    expect(submit.status).toBe(200);
    const body = await submit.json() as { taskId: string; subscribeToken?: string; subscribeTokenExpiresAt?: number };
    expect(typeof body.subscribeToken).toBe('string');
    expect(body.subscribeTokenExpiresAt).toBeGreaterThan(Date.now());

    const resp = await crowdApp.request(
      `/subscribe?taskId=${body.taskId}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': buildSubscribeProtocols(body.subscribeToken!).join(', ') } },
      env,
    );
    expect(resp.status).toBe(101);
    expect(resp.headers.get('Sec-WebSocket-Protocol')).toBe(SUBSCRIBE_PROTOCOL);
    (resp as unknown as { webSocket?: WebSocket }).webSocket?.accept();
  });

  it('rejects a subscribe without a token', async () => {
    const submit = await submitTask('key-sub-owner', { workload: 'ai-inference', payload: { task: 't' } }, env);
    const { taskId } = await submit.json() as { taskId: string };

    const resp = await crowdApp.request(
      `/subscribe?taskId=${taskId}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } },
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('rejects a subscribe token bound to another task', async () => {
    const submit = await submitTask('key-sub-owner', { workload: 'ai-inference', payload: { task: 't' } }, env);
    const { taskId } = await submit.json() as { taskId: string };
    const otherToken = await createSubscribeToken(TEST_SUBSCRIBE_TOKEN_SECRET, {
      tenantId: 'tenant-sub-owner',
      taskId: 'a-different-task',
      exp: Date.now() + 60_000,
    });

    const resp = await crowdApp.request(
      `/subscribe?taskId=${taskId}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': buildSubscribeProtocols(otherToken).join(', ') } },
      env,
    );
    expect(resp.status).toBe(403);
  });

  it('rejects an expired subscribe token', async () => {
    const expired = await createSubscribeToken(TEST_SUBSCRIBE_TOKEN_SECRET, {
      tenantId: 'tenant-sub-owner',
      taskId: 'task-x',
      exp: Date.now() - 1000,
    });
    const resp = await crowdApp.request(
      `/subscribe?taskId=task-x`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': buildSubscribeProtocols(expired).join(', ') } },
      env,
    );
    expect(resp.status).toBe(401);
  });

  it('cannot subscribe across tenants even with a validly signed token', async () => {
    // A task owned by the other tenant...
    const submit = await submitTask('key-sub-other', { workload: 'ai-inference', payload: { task: 't' } }, env);
    const { taskId } = await submit.json() as { taskId: string };

    // ...with a token minted for the owner tenant. The DO looks the task up
    // under the token's tenant, so this is a 404, never a stream.
    const crossTenant = await createSubscribeToken(TEST_SUBSCRIBE_TOKEN_SECRET, {
      tenantId: 'tenant-sub-owner',
      taskId,
      exp: Date.now() + 60_000,
    });
    const resp = await crowdApp.request(
      `/subscribe?taskId=${taskId}`,
      { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Protocol': buildSubscribeProtocols(crossTenant).join(', ') } },
      env,
    );
    expect(resp.status).toBe(404);
  });
});

describe('#3 tenant isolation of task reads', () => {
  it('returns 404 when another tenant asks for the task', async () => {
    const env = makeEnv({ API_KEYS: 'key-a:tenant-a,key-b:tenant-b' });
    const submit = await submitTask('key-a', { workload: 'ai-inference', payload: { task: 't', input: 'secret' } }, env);
    const { taskId } = await submit.json() as { taskId: string };

    const owner = await getTask('key-a', taskId, env);
    expect(owner.status).toBe(200);
    const record = await owner.json() as { tenantId: string; payload: { input?: string } };
    expect(record.tenantId).toBe('tenant-a');
    expect(record.payload.input).toBe('secret');

    const foreign = await getTask('key-b', taskId, env);
    expect(foreign.status).toBe(404);

    // The record lives under the tenant's key namespace, so there is no
    // unscoped lookup that could leak it either.
    expect(await readStoredTask('tenant-a', taskId)).toBeTruthy();
    expect(await readStoredTask('tenant-b', taskId)).toBeUndefined();
  });

  it('gives legacy keys without an explicit tenant distinct derived tenants', async () => {
    const env = makeEnv({ API_KEYS: 'legacy-key-one,legacy-key-two' });
    const submit = await submitTask('legacy-key-one', { workload: 'ai-inference', payload: { task: 't' } }, env);
    const { taskId } = await submit.json() as { taskId: string };

    const owner = await getTask('legacy-key-one', taskId, env);
    expect(owner.status).toBe(200);
    const record = await owner.json() as { tenantId: string };
    expect(record.tenantId).toMatch(/^key-[0-9a-f]{16}$/);

    // Backward compatible: the legacy key still works. Only cross-tenant access
    // is denied, and each legacy key is its own tenant.
    expect((await getTask('legacy-key-two', taskId, env)).status).toBe(404);
  });

  it('still rejects unknown keys', async () => {
    const env = makeEnv({ API_KEYS: 'key-a:tenant-a' });
    const resp = await crowdApp.request('/tasks/whatever', { headers: { Authorization: 'Bearer nope' } }, env);
    expect(resp.status).toBe(401);
  });

  it('stores the site allow-list on the task', async () => {
    const env = makeEnv({ API_KEYS: 'key-sites:tenant-sites' });
    const submit = await submitTask(
      'key-sites',
      { workload: 'ai-inference', payload: { task: 't', allowedSites: ['trusted.example'] } },
      env,
    );
    expect(submit.status).toBe(200);
    const { taskId } = await submit.json() as { taskId: string };
    const record = await readStoredTask('tenant-sites', taskId);
    expect(record?.allowedSites).toEqual(['trusted.example']);
  });

  it('rejects a malformed site allow-list', async () => {
    const env = makeEnv({ API_KEYS: 'key-sites-bad:tenant-sites-bad' });
    for (const allowedSites of [[], ['ok', 42], 'trusted.example', Array.from({ length: 20 }, (_, i) => `s${i}`)]) {
      const resp = await submitTask(
        'key-sites-bad',
        { workload: 'ai-inference', payload: { task: 't', allowedSites } },
        env,
      );
      expect(resp.status).toBe(400);
    }
  });
});

describe('#6 swarm sizing bounds at the API boundary', () => {
  const env = makeEnv({ API_KEYS: 'key-bounds:tenant-bounds' });

  it('rejects minNodes / maxNodes beyond the documented maximum', async () => {
    for (const swarm of [{ minNodes: 99999 }, { maxNodes: 1000000 }, { minNodes: 1, maxNodes: 17 }]) {
      const resp = await submitTask(
        'key-bounds',
        { workload: 'swarm-inference', payload: { model: 'm', prompt: 'p', swarm } },
        env,
      );
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error?: string };
      expect(body.error).toMatch(/swarm\.(minNodes|maxNodes)/);
    }
  });

  it('accepts the documented range', async () => {
    const resp = await submitTask(
      'key-bounds',
      { workload: 'swarm-inference', payload: { model: 'm', prompt: 'p', swarm: { minNodes: 2, maxNodes: 16 } } },
      env,
    );
    expect(resp.status).toBe(200);
  });
});

describe('#13 webhook signing fails closed', () => {
  it('rejects localhost and non-HTTPS webhook destinations', () => {
    for (const url of [
      'http://localhost/callback',
      'http://127.0.0.1/callback',
      'http://[::1]/callback',
      'https://169.254.169.254/latest/meta-data',
    ]) expect(validateCallbackUrl(url)).toBeNull();
    expect(validateCallbackUrl('https://hooks.example/callback')).toBe('https://hooks.example/callback');
  });

  it('rejects a callbackUrl when the signing secret is not configured', async () => {
    const env = makeEnv({ API_KEYS: 'key-hook:tenant-hook', WEBHOOK_SIGNING_SECRET: '' });
    const resp = await submitTask(
      'key-hook',
      { workload: 'ai-inference', payload: { task: 't' }, callbackUrl: 'https://example.com/hook' },
      env,
    );
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toMatch(/WEBHOOK_SIGNING_SECRET/);

    // The same task without a callback is unaffected.
    const ok = await submitTask('key-hook', { workload: 'ai-inference', payload: { task: 't' } }, env);
    expect(ok.status).toBe(200);
  });

  it('accepts a callbackUrl when the signing secret is configured', async () => {
    const env = makeEnv({ API_KEYS: 'key-hook-ok:tenant-hook-ok' });
    const resp = await submitTask(
      'key-hook-ok',
      { workload: 'ai-inference', payload: { task: 't' }, callbackUrl: 'https://example.com/hook' },
      env,
    );
    expect(resp.status).toBe(200);
  });
});