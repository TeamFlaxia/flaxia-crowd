import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CROWD_WEBHOOK_NONCE_HEADER,
  CROWD_WEBHOOK_SIGNATURE_HEADER,
  CROWD_WEBHOOK_TIMESTAMP_HEADER,
  createMemoryReplayGuard,
  parseCrowdWebhook,
  readCrowdWebhookHeaders,
  verifyCrowdWebhook,
  webhookSigningString,
} from '../webhook';

const SECRET = 'whsec_test_0123456789';
const NOW = 1_760_000_000;

/** Sign exactly the way the worker does, with an independent implementation. */
function sign(secret: string, timestamp: string, nonce: string, body: string): string {
  const mac = createHmac('sha256', secret)
    .update(webhookSigningString(timestamp, nonce, body))
    .digest('base64url');
  return `sha256=${mac}`;
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ taskId: 'task-1', status: 'done', result: { output: { ok: true } }, ...overrides });
}

function headers(body: string, overrides: Partial<Record<'signature' | 'timestamp' | 'nonce', string | null>> = {}) {
  const timestamp = overrides.timestamp ?? String(NOW);
  const nonce = overrides.nonce ?? 'nonce-1';
  const signature = overrides.signature === undefined ? sign(SECRET, String(timestamp), String(nonce), body) : overrides.signature;
  return { signature, timestamp, nonce };
}

describe('verifyCrowdWebhook', () => {
  it('accepts a delivery signed over timestamp.nonce.body', async () => {
    const body = event();
    const result = await verifyCrowdWebhook({ secret: SECRET, body, ...headers(body), now: NOW });
    expect(result).toEqual({
      ok: true,
      payload: { taskId: 'task-1', status: 'done', result: { output: { ok: true } } },
    });
  });

  it('rejects a tampered body', async () => {
    const body = event();
    const signed = headers(body);
    const tampered = event({ result: { output: { ok: false } } });
    const result = await verifyCrowdWebhook({ secret: SECRET, body: tampered, ...signed, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects the wrong secret', async () => {
    const body = event();
    const result = await verifyCrowdWebhook({ secret: 'other-secret', body, ...headers(body), now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects a stale timestamp', async () => {
    const body = event();
    const signed = headers(body);
    const result = await verifyCrowdWebhook({
      secret: SECRET, body, ...signed, now: NOW + 3600,
    });
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('honours a custom tolerance', async () => {
    const body = event();
    const signed = headers(body);
    const result = await verifyCrowdWebhook({
      secret: SECRET, body, ...signed, now: NOW + 3600, toleranceSeconds: 7200,
    });
    expect(result.ok).toBe(true);
  });

  it('requires a nonce', async () => {
    const body = event();
    const signed = headers(body);
    const result = await verifyCrowdWebhook({ secret: SECRET, body, ...signed, nonce: null, now: NOW });
    expect(result).toEqual({ ok: false, reason: 'missing_nonce' });
  });

  it('rejects a malformed nonce', async () => {
    const body = event();
    const signed = headers(body);
    const result = await verifyCrowdWebhook({ secret: SECRET, body, ...signed, nonce: 'x'.repeat(200), now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_nonce' });
  });

  it('rejects missing, malformed and unprefixed signatures', async () => {
    const body = event();
    expect(await verifyCrowdWebhook({ secret: SECRET, body, ...headers(body), signature: null, now: NOW }))
      .toEqual({ ok: false, reason: 'missing_signature' });
    expect(await verifyCrowdWebhook({ secret: SECRET, body, ...headers(body), signature: 'deadbeef', now: NOW }))
      .toEqual({ ok: false, reason: 'malformed_signature' });
    expect(await verifyCrowdWebhook({ secret: SECRET, body, ...headers(body), signature: 'sha256=', now: NOW }))
      .toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('rejects a missing secret', async () => {
    const body = event();
    const result = await verifyCrowdWebhook({ secret: '', body, ...headers(body), now: NOW });
    expect(result).toEqual({ ok: false, reason: 'missing_secret' });
  });

  it('rejects a body that is not a crowd callback', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const result = await verifyCrowdWebhook({ secret: SECRET, body, ...headers(body), now: NOW });
    expect(result).toEqual({ ok: false, reason: 'invalid_body' });
  });

  it('rejects a replay when the caller supplies a guard', async () => {
    const body = event();
    const signed = headers(body);
    const guard = createMemoryReplayGuard({ now: () => NOW * 1000 });

    const first = await verifyCrowdWebhook({ secret: SECRET, body, ...signed, now: NOW, replayGuard: guard });
    expect(first.ok).toBe(true);

    const second = await verifyCrowdWebhook({ secret: SECRET, body, ...signed, now: NOW, replayGuard: guard });
    expect(second).toEqual({ ok: false, reason: 'replayed_nonce' });

    // A different nonce is a different delivery.
    const other = headers(body, { nonce: 'nonce-2' });
    const third = await verifyCrowdWebhook({ secret: SECRET, body, ...other, now: NOW, replayGuard: guard });
    expect(third.ok).toBe(true);
  });

  it('does not consult the replay guard before the signature checks out', async () => {
    const body = event();
    const signed = headers(body);
    const checked: string[] = [];
    const guard = { check: (nonce: string) => { checked.push(nonce); return true; } };

    const result = await verifyCrowdWebhook({
      secret: SECRET, body, ...signed, signature: 'sha256=bogus', now: NOW, replayGuard: guard,
    });
    expect(result.ok).toBe(false);
    expect(checked).toEqual([]);
  });

  it('reads the three headers off a request', () => {
    const requestHeaders = new Headers({
      [CROWD_WEBHOOK_SIGNATURE_HEADER]: 'sha256=abc',
      [CROWD_WEBHOOK_TIMESTAMP_HEADER]: '123',
      [CROWD_WEBHOOK_NONCE_HEADER]: 'n1',
    });
    expect(readCrowdWebhookHeaders(requestHeaders)).toEqual({
      signature: 'sha256=abc', timestamp: '123', nonce: 'n1',
    });
  });

  it('keeps parseCrowdWebhook working for already-verified bodies', () => {
    expect(parseCrowdWebhook({ taskId: 't', status: 'done' })).toEqual({ taskId: 't', status: 'done' });
  });
});

describe('createMemoryReplayGuard', () => {
  it('evicts entries once their lifetime has passed', () => {
    let now = 0;
    // An entry lives until the tolerance window ends (or the fallback TTL,
    // whichever is later), so a replay inside the window is always rejected.
    const guard = createMemoryReplayGuard({ now: () => now, ttlSeconds: 1 });
    expect(guard.check('n1', 1000)).toBe(true);
    expect(guard.check('n1', 1000)).toBe(false);
    now = 2000;
    expect(guard.check('n1', 3000)).toBe(true);
  });

  it('bounds the number of stored nonces', () => {
    const guard = createMemoryReplayGuard({ maxEntries: 2 });
    expect(guard.check('a', Date.now() + 1000)).toBe(true);
    expect(guard.check('b', Date.now() + 1000)).toBe(true);
    expect(guard.check('c', Date.now() + 1000)).toBe(true);
    // 'a' was evicted, so it is accepted again rather than growing forever.
    expect(guard.check('a', Date.now() + 1000)).toBe(true);
  });
});