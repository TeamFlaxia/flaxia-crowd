import type { TaskRecord, TaskStatus } from './types';

/**
 * Webhook authentication contract (worker signs, host verifies).
 *
 * The signature covers `"<timestamp>.<nonce>.<raw body>"`, so a captured
 * (body, signature) pair is only replayable inside the tolerance window and
 * only once per nonce. The timestamp and nonce travel in dedicated headers.
 */
export const CROWD_WEBHOOK_SIGNATURE_HEADER = 'X-Flaxia-Signature';
export const CROWD_WEBHOOK_TIMESTAMP_HEADER = 'X-Flaxia-Timestamp';
export const CROWD_WEBHOOK_NONCE_HEADER = 'X-Flaxia-Nonce';

/** Prefix the worker puts in front of the base64url HMAC. */
export const CROWD_WEBHOOK_SIGNATURE_PREFIX = 'sha256=';

/** Default accepted clock skew for a webhook timestamp, in seconds. */
export const DEFAULT_CROWD_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Hard cap on the nonce length, so a caller cannot fill a nonce store. */
export const MAX_CROWD_WEBHOOK_NONCE_CHARS = 128;

/**
 * Terminal task status as delivered to a host via HTTP callback (webhook).
 * Non-terminal states are never sent, so the callback contract is narrower than
 * the full {@link TaskStatus}.
 */
export type CrowdCallbackStatus = Extract<TaskStatus, 'done' | 'failed'>;

/**
 * The orchestrator's callback body. Note the shape mirrors {@link TaskRecord}
 * for `result`/`error` but only carries the fields a host needs to react.
 */
export interface CrowdWebhookEvent<TResult = unknown> {
  taskId: string;
  status: CrowdCallbackStatus;
  /**
   * Orchestrator result envelope. The workload's own payload lives under
   * `result.output`; some workloads also place it at the top level of `result`.
   */
  result?: { output?: TResult; [key: string]: unknown };
  error?: string;
}

/**
 * Validate and normalize an untrusted webhook body. Returns `null` when the
 * payload is not a well-formed crowd callback so callers can safely `400`.
 */
export function parseCrowdWebhook<TResult = unknown>(body: unknown): CrowdWebhookEvent<TResult> | null {
  if (!body || typeof body !== 'object') return null;

  const record = body as Record<string, unknown>;
  const taskId = record.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;

  const status = record.status;
  if (status !== 'done' && status !== 'failed') return null;

  const event: CrowdWebhookEvent<TResult> = { taskId, status };

  if (record.result && typeof record.result === 'object') {
    event.result = record.result as CrowdWebhookEvent<TResult>['result'];
  }
  if (typeof record.error === 'string') {
    event.error = record.error;
  }

  return event;
}

/**
 * Extract the workload payload from a callback result. Workloads historically
 * disagree on nesting, so hosts should use this instead of poking at the raw
 * envelope: it prefers `result.output` and falls back to `result` itself.
 */
export function extractCallbackOutput<TResult = unknown>(
  event: CrowdWebhookEvent<TResult>,
): TResult | undefined {
  const result = event.result;
  if (!result) return undefined;
  if (result.output !== undefined) return result.output;
  return result as TResult;
}

// --- Webhook verification ---

/** Why a webhook was rejected. Hosts can log this; never branch on it for auth. */
export type CrowdWebhookVerifyFailure =
  | 'missing_secret'
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'stale_timestamp'
  | 'missing_nonce'
  | 'invalid_nonce'
  | 'invalid_signature'
  | 'replayed_nonce'
  | 'invalid_body';

/**
 * Caller-supplied replay guard. `check` is called only after the signature has
 * been verified, so an unauthenticated request can never poison the store.
 * Return `false` when the nonce was already seen; the entry should live until
 * `expiresAtMs` (the moment the timestamp tolerance runs out).
 */
export interface CrowdWebhookReplayGuard {
  check(nonce: string, expiresAtMs: number): boolean | Promise<boolean>;
}

export interface VerifyCrowdWebhookOptions {
  /** The dedicated webhook signing secret (never the node token secret). */
  secret: string;
  /** The raw request body exactly as received (do not re-serialize it). */
  body: string;
  /** `X-Flaxia-Signature` header value. */
  signature?: string | null;
  /** `X-Flaxia-Timestamp` header value (unix seconds). */
  timestamp?: string | number | null;
  /** `X-Flaxia-Nonce` header value. */
  nonce?: string | null;
  /** Accepted clock skew in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Current unix time in seconds; injectable for tests. */
  now?: number;
  replayGuard?: CrowdWebhookReplayGuard;
}

export type VerifyCrowdWebhookResult<TResult = unknown> =
  | { ok: true; payload: CrowdWebhookEvent<TResult> }
  | { ok: false; reason: CrowdWebhookVerifyFailure };

/** The exact string the worker signs for a webhook delivery. */
export function webhookSigningString(
  timestamp: string | number,
  nonce: string,
  body: string,
): string {
  return `${timestamp}.${nonce}.${body}`;
}

/** Read the three webhook headers from a request. */
export function readCrowdWebhookHeaders(headers: Headers): {
  signature: string | null;
  timestamp: string | null;
  nonce: string | null;
} {
  return {
    signature: headers.get(CROWD_WEBHOOK_SIGNATURE_HEADER),
    timestamp: headers.get(CROWD_WEBHOOK_TIMESTAMP_HEADER),
    nonce: headers.get(CROWD_WEBHOOK_NONCE_HEADER),
  };
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding; implemented locally so no runtime polyfill is needed. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Length-independent, value-constant comparison of two strings. */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Verify a crowd webhook and return its parsed payload.
 *
 * Checks, in order: secret configured, signature header shape, timestamp
 * presence and freshness, nonce presence and shape, HMAC, replay guard, body
 * shape. Any failure yields `{ ok: false, reason }` — callers must not treat a
 * failed verification as a valid event.
 */
export async function verifyCrowdWebhook<TResult = unknown>(
  options: VerifyCrowdWebhookOptions,
): Promise<VerifyCrowdWebhookResult<TResult>> {
  const { secret, body, replayGuard } = options;
  if (!secret) return { ok: false, reason: 'missing_secret' };

  const signature = options.signature ?? null;
  if (!signature) return { ok: false, reason: 'missing_signature' };
  if (!signature.startsWith(CROWD_WEBHOOK_SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const providedMac = signature.slice(CROWD_WEBHOOK_SIGNATURE_PREFIX.length);
  if (!providedMac) return { ok: false, reason: 'malformed_signature' };

  const rawTimestamp = options.timestamp;
  if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === '') {
    return { ok: false, reason: 'missing_timestamp' };
  }
  const timestampText = String(rawTimestamp);
  const timestampSeconds = Number(timestampText);
  if (!Number.isFinite(timestampSeconds) || !/^\d+$/.test(timestampText)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_CROWD_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const nonce = options.nonce ?? null;
  if (!nonce) return { ok: false, reason: 'missing_nonce' };
  if (nonce.length > MAX_CROWD_WEBHOOK_NONCE_CHARS || !/^[A-Za-z0-9._:-]+$/.test(nonce)) {
    return { ok: false, reason: 'invalid_nonce' };
  }

  const expectedMac = await hmacSha256Base64Url(
    secret,
    webhookSigningString(timestampText, nonce, body),
  );
  if (!constantTimeEqual(expectedMac, providedMac)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  if (replayGuard) {
    const expiresAtMs = (timestampSeconds + toleranceSeconds) * 1000;
    const accepted = await replayGuard.check(nonce, expiresAtMs);
    if (!accepted) return { ok: false, reason: 'replayed_nonce' };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid_body' };
  }
  const payload = parseCrowdWebhook<TResult>(parsedBody);
  if (!payload) return { ok: false, reason: 'invalid_body' };

  return { ok: true, payload };
}

export interface MemoryReplayGuardOptions {
  /** Maximum nonces kept in memory. Oldest entries are evicted first. */
  maxEntries?: number;
  /** Fallback entry lifetime in seconds when the caller does not pass one. */
  ttlSeconds?: number;
  /** Injectable clock (unix ms). */
  now?: () => number;
}

/**
 * Small in-memory nonce store for single-instance hosts and tests. Multi-instance
 * hosts must supply their own shared store (KV/D1/Redis) with the same contract.
 */
export function createMemoryReplayGuard(options: MemoryReplayGuardOptions = {}): CrowdWebhookReplayGuard {
  const maxEntries = options.maxEntries ?? 1024;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_CROWD_WEBHOOK_TOLERANCE_SECONDS;
  const now = options.now ?? (() => Date.now());
  const seen = new Map<string, number>();

  return {
    check(nonce: string, expiresAtMs: number): boolean {
      const current = now();
      for (const [key, expiry] of seen) {
        if (expiry <= current) seen.delete(key);
      }
      if (seen.has(nonce)) return false;
      while (seen.size >= maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seen.set(nonce, Math.max(expiresAtMs, current + ttlSeconds * 1000));
      return true;
    },
  };
}

export interface CallbackUrlOptions {
  /** Host base URL, e.g. `https://flaxia.app`. Trailing slashes are tolerated. */
  baseUrl: string;
  /** Callback path on the host. Defaults to `/api/crowd/webhook`. */
  path?: string;
  /** Discriminator for the completed workload, placed in the `type` param. */
  type: string;
  /** Extra query params. `undefined`, `null` and `''` values are skipped. */
  params?: Record<string, string | number | undefined | null>;
}

/**
 * Build the `callbackUrl` a host passes to {@link import('./client').FlaxiaClient.submit}.
 * Centralizes URL shape so every host integration produces identical callbacks.
 */
export function buildCallbackUrl(options: CallbackUrlOptions): string {
  const base = options.baseUrl.replace(/\/+$/, '');
  const path = options.path ?? '/api/crowd/webhook';
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);

  url.searchParams.set('type', options.type);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/** Read the workload discriminator out of a callback request URL. */
export function callbackTypeFromUrl(url: URL | string): string | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.searchParams.get('type');
}

/** Type guard for full task records returned by the polling API. */
export function isTerminalTask(task: Pick<TaskRecord, 'status'>): boolean {
  return task.status === 'done' || task.status === 'failed';
}