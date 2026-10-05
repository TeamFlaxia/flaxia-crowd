import type { SwarmNodeCapabilities, WarmModelRange } from '@flaxia/sdk';

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(input: string): string {
  return bytesToBase64Url(encoder.encode(input));
}

function base64UrlDecode(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256B64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
}

// --- API keys and tenants ---

/**
 * Tenant identity for an API key.
 *
 * `API_KEYS` entries are `key` or `key:tenantId`. An entry without an explicit
 * tenant gets a stable id derived from the key itself, so two legacy keys still
 * cannot read each other's tasks (each key is its own tenant) without an
 * operator having to rewrite the configuration.
 */
export function deriveTenantId(apiKey: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', encoder.encode(apiKey)).then((digest) => {
    return `key-${bytesToHex(new Uint8Array(digest)).slice(0, 16)}`;
  });
}

export interface ApiKeyEntry {
  key: string;
  tenantId: string;
}

const apiKeyCache = new Map<string, ApiKeyEntry[]>();

/** Parse `API_KEYS` into key/tenant pairs (cached per raw configuration string). */
export async function parseApiKeyEntries(raw: string | undefined): Promise<ApiKeyEntry[]> {
  const config = raw || '';
  const cached = apiKeyCache.get(config);
  if (cached) return cached;

  const entries: ApiKeyEntry[] = [];
  for (const part of config.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    const key = separator === -1 ? trimmed : trimmed.slice(0, separator);
    if (!key) continue;
    const explicit = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    entries.push({ key, tenantId: explicit || await deriveTenantId(key) });
  }

  if (apiKeyCache.size > 8) apiKeyCache.clear();
  apiKeyCache.set(config, entries);
  return entries;
}

/** Resolve the tenant id of a bearer token, or `null` when no key matches. */
export async function resolveTenantId(
  rawApiKeys: string | undefined,
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  const entries = await parseApiKeyEntries(rawApiKeys);
  for (const entry of entries) {
    if (safeEqual(entry.key, token)) return entry.tenantId;
  }
  return null;
}

// --- Node registration tokens ---

export interface NodeTokenPayload {
  siteId: string;
  nodeId: string;
  capabilities: string[];
  exp: number;
  /** Device RAM in GB as reported by the browser; `null`/missing on mobile WebViews. */
  deviceMemory?: number | null;
  /** Measured WASM memory the device can commit, used as swarm split capacity. */
  wasmMemoryBytes?: number;
  /** WebGPU capabilities probed by the node, for swarm inference routing. */
  swarm?: SwarmNodeCapabilities;
  /** Warm model layer ranges the node can serve without downloading. */
  warmModels?: WarmModelRange[];
}

/**
 * Fresh 256-bit key for one swarm hop edge, base64url encoded. The coordinator
 * hands each member its inbound/outbound key in `swarm-slice` and never keeps
 * them: frames are authenticated between neighbours, not by the relay.
 */
export function createSwarmHopKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Node tokens are short-lived because a node re-registers on every connect (the
 * raw token is no longer cached in `localStorage`). Two hours keeps a long-lived
 * socket working while bounding the value of a leaked token.
 */
export const NODE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export async function createNodeToken(secret: string, payload: NodeTokenPayload): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSha256B64(secret, body);
  return `${body}.${sig}`;
}

export async function verifyNodeToken(secret: string, token: string | null): Promise<NodeTokenPayload | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmacSha256B64(secret, body);
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as NodeTokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.siteId !== 'string' || !payload.siteId) return null;
    // The node id is part of the signed payload: a token can never be presented
    // as (or for) a different node than the one it was issued to.
    if (typeof payload.nodeId !== 'string' || !payload.nodeId) return null;
    if (!Array.isArray(payload.capabilities)) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Self-reported capacity bounds ---

/**
 * Ceiling for any capacity a node reports about itself (`wasmMemoryBytes`,
 * WebGPU buffer limits). A node that advertises `1e300` would otherwise always
 * win host election; clamping makes lying about capacity pointless beyond the
 * ceiling while keeping honest large devices ahead of small ones.
 */
export const MAX_WASM_MEMORY_BYTES = 16 * 1024 ** 3;

/** Deepest model layer index accepted from a warm-model report. */
export const MAX_WARM_MODEL_LAYERS = 4096;

/** Validate + clamp a self-reported byte capacity; `undefined` when unusable. */
export function clampByteCapacity(value: unknown, max = MAX_WASM_MEMORY_BYTES): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), max);
}

// --- Subscribe tokens ---

/**
 * Subscribe tokens are handed to the requester with the task record and are
 * required by `GET /crowd/subscribe`. They are bound to one tenant + task and
 * expire quickly, so a leaked task id alone no longer exposes results.
 */
export const SUBSCRIBE_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface SubscribeTokenPayload {
  tenantId: string;
  taskId: string;
  exp: number;
}

export async function createSubscribeToken(secret: string, payload: SubscribeTokenPayload): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = await hmacSha256B64(secret, body);
  return `${body}.${sig}`;
}

export async function verifySubscribeToken(secret: string, token: string | null): Promise<SubscribeTokenPayload | null> {
  if (!secret || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmacSha256B64(secret, body);
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as SubscribeTokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    if (typeof payload.tenantId !== 'string' || !payload.tenantId) return null;
    if (typeof payload.taskId !== 'string' || !payload.taskId) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Webhook signatures ---

/** The exact string covered by a webhook signature. */
export function webhookSigningString(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

/**
 * Sign a webhook delivery. The timestamp + nonce make a captured
 * (body, signature) pair replayable only inside the receiver's tolerance window
 * and only once, and the dedicated secret keeps webhook forgery independent of
 * the node token plane.
 */
export async function createWebhookSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
): Promise<string> {
  return `sha256=${await hmacSha256B64(secret, webhookSigningString(timestamp, nonce, body))}`;
}

// --- callbackUrl validation (SSRF guard) ---

function parseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let ip = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = parseInt(part, 10);
    if (n > 255) return null;
    ip = (ip << 8) | n;
  }
  return ip >>> 0;
}

function isPrivateIPv4(ip: number): boolean {
  const a = ip >>> 24;
  const b = (ip >>> 16) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 192 && (b === 0 || b === 2 || b === 168)) ||
    (a === 203 && b === 0)
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1') return true;
  // IPv4-mapped: ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const ip = parseIPv4(mapped[1]);
    return ip !== null && isPrivateIPv4(ip);
  }
  // fc00::/7 and fe80::/10 and ff00::/8
  return /^(fc|fd)/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h);
}

function isSafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host === '0.0.0.0') return false;
  if (/.+\.(local|internal)$/.test(host) || /\.internal\./.test(host)) return false;
  if (host.endsWith('.localhost')) return false;
  if (/^::1$/.test(host)) return false;

  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return !isPrivateIPv4(ipv4);

  if (/^[0-9a-f:]+$/i.test(host) && host.includes(':')) {
    return !isPrivateIPv6(host);
  }

  return true;
}

export function validateCallbackUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Webhooks are always HTTPS and must never target a literal private host.
  // This validation is repeated at delivery time because stored task records
  // can outlive submission and may have been created by an older deployment.
  return url.protocol === 'https:' && isSafeHostname(url.hostname) ? url.toString() : null;
}
