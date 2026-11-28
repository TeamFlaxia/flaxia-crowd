/**
 * Node-side egress guard for every workload that fetches a customer-supplied
 * URL (container WASM images, nudenet image URLs, ...).
 *
 * A volunteer node runs inside the visitor's browser, so a customer-supplied
 * URL turns that visitor's residential IP into a request proxy (SSRF): the
 * browser will happily reach loopback, the visitor's LAN, CGNAT/Tailscale
 * addresses, cloud metadata endpoints and `.local`/`.internal` names. The guard
 * below is the single place that decides whether a URL may be fetched at all;
 * the host/range rules themselves come from `@flaxia/sdk` so the worker and the
 * node cannot drift apart.
 *
 * What it enforces:
 *  - `https:` only, no embedded credentials (`user:pass@host`);
 *  - the host may not be, or resolve syntactically to, loopback / private /
 *    link-local / CGNAT / ULA / IPv4-mapped-IPv6 / unspecified / `0.0.0.0/8` /
 *    multicast / reserved space, NAT64 / 6to4 / Teredo / documentation ranges,
 *    and may not end in `.local` or `.internal` (a single trailing dot is
 *    normalized away before those checks);
 *  - only the default HTTPS port is allowed;
 *  - redirects are followed manually and every hop is re-validated (an
 *    environment that hides `Location` on a manual redirect gets the request
 *    rejected instead — fail closed);
 *  - `Content-Type` must be on the caller's allowlist;
 *  - the body is streamed and aborted once it passes the byte cap (the
 *    `Content-Length` header is never trusted);
 *  - an `AbortSignal` timeout bounds the whole exchange.
 *
 * Residual risk (documented, not silently ignored): the browser resolves the
 * hostname, so a DNS name that only *later* resolves to a private address
 * cannot be detected from JavaScript without a DNS API. IP literals and
 * private-looking names are rejected here; public names are additionally
 * protected by the browser's Private Network Access checks.
 */

import {
  isBlockedIPv4Host,
  isBlockedIPv6Host,
  isSafePublicHostname,
  normalizeHostname,
  parseIPv6Address,
} from '@flaxia/sdk';

/** Hard default response-size cap (8 MiB) when a caller does not set one. */
export const DEFAULT_MAX_EGRESS_BYTES = 8 * 1024 * 1024;
/** Hard ceiling for any caller-provided cap (256 MiB). */
export const MAX_EGRESS_BYTES = 256 * 1024 * 1024;
/** Default whole-exchange timeout. */
export const DEFAULT_EGRESS_TIMEOUT_MS = 30_000;
/** Redirect hops we are willing to re-validate. */
export const MAX_EGRESS_REDIRECTS = 3;
/** Only the default HTTPS port is allowed: odd ports are a common SSRF pivot. */
export const ALLOWED_EGRESS_PORTS = [443];

export interface EgressRequest {
  /** Absolute URL to fetch. */
  url: string | URL;
  /** `Content-Type` prefixes (or exact media types) accepted for the body. */
  allowContentTypes: readonly string[];
  /** Maximum response body size in bytes (clamped to `MAX_EGRESS_BYTES`). */
  maxBytes?: number;
  /** Whole-exchange timeout in ms (applied with `AbortSignal.timeout`). */
  timeoutMs?: number;
  /** Extra request headers (validated: hop-by-hop headers are not allowed). */
  headers?: Record<string, string>;
  /** HTTP method; only GET/HEAD are meaningful for these workloads. */
  method?: 'GET' | 'HEAD';
}

export interface EgressResult {
  /** Final URL after the (manually validated) redirect chain. */
  url: string;
  status: number;
  ok: boolean;
  /** `Content-Type` of the final response, lowercased without parameters. */
  contentType: string;
  /** Full body bytes; empty for HEAD or an error status. */
  bytes: Uint8Array<ArrayBuffer>;
  byteLength: number;
}

export interface EgressGuardOptions {
  /** Override the accepted ports (tests / non-default deployments). */
  allowedPorts?: readonly number[];
  /** Allow `http:` as well as `https:`. Never enable in production. */
  allowInsecure?: boolean;
}

function fail(message: string): never {
  throw new Error(`Egress blocked: ${message}`);
}

/** Reject URLs that carry credentials, whatever the protocol. */
function assertNoCredentials(url: URL): void {
  if (url.username || url.password) {
    fail(`credentials in URL are not allowed (${url.protocol}//${url.hostname})`);
  }
}

/**
 * True when a dotted-decimal IPv4 literal belongs to a range a volunteer node
 * must never reach.
 */
export function isBlockedIPv4(host: string): boolean {
  return isBlockedIPv4Host(host);
}

/** Expand an IPv6 literal into eight 16-bit groups (SDK shared helper). */
export function parseIPv6(host: string): number[] | null {
  return parseIPv6Address(host);
}

/**
 * True when an IPv6 literal is an address a volunteer node must never reach.
 * The range list lives in `@flaxia/sdk` and also covers NAT64, 6to4, Teredo
 * and documentation prefixes; unparseable literals fail closed.
 */
export function isBlockedIPv6(host: string): boolean {
  return isBlockedIPv6Host(host);
}

/**
 * Validate a hostname (or IP literal) independently of the URL parser. Exported
 * so workloads can pre-check a host and so the rules are unit-testable.
 */
export function assertPublicHostname(hostname: string, _options: EgressGuardOptions = {}): void {
  const host = normalizeHostname(hostname);
  if (!host) fail('empty hostname');
  if (host.startsWith('[') || host.includes(':')) {
    // IPv6 literal: anything we cannot parse is rejected (fail closed) so a
    // malformed literal can never slip past the range checks below.
    if (!parseIPv6(host)) fail(`invalid IPv6 literal: ${host}`);
    if (isBlockedIPv6(host)) fail(`IPv6 address blocked: ${host}`);
    return;
  }
  if (!isSafePublicHostname(host)) {
    if (isBlockedIPv4(host)) fail(`IPv4 address blocked: ${host}`);
    fail(`host blocked: ${host}`);
  }
}

/**
 * Validate an egress URL: protocol, credentials, port and host. Returns the
 * parsed `URL` so callers can reuse it (and so redirect hops share one path).
 */
export function assertPublicUrl(input: string | URL, options: EgressGuardOptions = {}): URL {
  let url: URL;
  if (input instanceof URL) {
    url = new URL(input.toString());
  } else {
    try {
      url = new URL(input);
    } catch {
      fail(`invalid URL: ${String(input)}`);
    }
  }

  const allowedProtocols = options.allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    fail(`protocol not allowed: ${url.protocol}`);
  }
  assertNoCredentials(url);

  const ports = options.allowedPorts ?? ALLOWED_EGRESS_PORTS;
  if (url.port && !ports.includes(Number(url.port))) {
    fail(`port not allowed: ${url.port}`);
  }

  assertPublicHostname(url.hostname, options);
  return url;
}

/** Normalized `Content-Type` (lowercase, parameters stripped). */
function normalizeContentType(header: string | null): string {
  if (!header) return '';
  return header.split(';')[0]!.trim().toLowerCase();
}

function isAllowedContentType(contentType: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return false;
  for (const entry of allow) {
    const pattern = entry.toLowerCase();
    if (pattern.endsWith('/*')) {
      if (contentType.startsWith(pattern.slice(0, -1))) return true;
    } else if (contentType === pattern) {
      return true;
    }
  }
  return false;
}

function resolveRedirectUrl(location: string, base: URL): string {
  try {
    return new URL(location, base).toString();
  } catch {
    fail(`invalid redirect location: ${location}`);
  }
}

/** Read a response body with a hard byte cap; never trusts `Content-Length`. */
async function readCapped(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(`response too large: ${url} declares ${declared} bytes (cap ${maxBytes})`);
  }

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    // Environment without streaming bodies (older jsdom / stub responses):
    // buffer once and enforce the cap on the resulting length.
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      fail(`response too large: ${url} returned ${buffer.byteLength} bytes (cap ${maxBytes})`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelled = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Abort mid-stream: a chunked response without Content-Length must not
        // be able to fill the volunteer's memory before we notice.
        cancelled = true;
        await reader.cancel().catch(() => undefined);
        fail(`response too large: ${url} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    if (!cancelled) reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Fetch a customer-supplied URL through the guard. Redirects are resolved
 * manually so each hop is re-validated; the body is capped while streaming.
 */
export async function fetchGuarded(
  request: EgressRequest,
  options: EgressGuardOptions = {},
): Promise<EgressResult> {
  if (typeof request.url !== 'string' && !(request.url instanceof URL)) {
    fail('url must be a string or URL');
  }
  if (!Array.isArray(request.allowContentTypes) || request.allowContentTypes.length === 0) {
    // Fail closed: an empty allowlist would otherwise accept every body.
    fail('no Content-Type allowlist configured');
  }

  const maxBytes = Math.min(
    Math.max(1, Math.floor(request.maxBytes ?? DEFAULT_MAX_EGRESS_BYTES)),
    MAX_EGRESS_BYTES,
  );
  const timeoutMs = Math.max(1, Math.floor(request.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS));
  const method = request.method ?? 'GET';

  let current = assertPublicUrl(request.url, options);
  let redirects = 0;

  for (;;) {
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method,
        headers: request.headers,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      fail(`request failed: ${current.toString()} (${err instanceof Error ? err.message : String(err)})`);
    }

    // `redirect: 'manual'` yields an opaqueredirect response in browsers, whose
    // status and headers are hidden. We cannot re-validate what we cannot read,
    // so such a response is rejected instead of followed blindly.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      if (response.status === 0 || response.type === 'opaqueredirect') {
        fail(`redirect could not be validated: ${current.toString()}`);
      }
      const location = response.headers.get('location');
      if (!location) fail(`redirect without Location: ${current.toString()}`);
      if (redirects >= MAX_EGRESS_REDIRECTS) {
        fail(`too many redirects (>${MAX_EGRESS_REDIRECTS})`);
      }
      redirects++;
      current = assertPublicUrl(resolveRedirectUrl(location, current), options);
      continue;
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    if (!isAllowedContentType(contentType, request.allowContentTypes)) {
      fail(`content-type not allowed: ${contentType || '(missing)'} for ${current.toString()}`);
    }

    const bytes = response.ok && method !== 'HEAD'
      ? await readCapped(response, maxBytes, current.toString())
      : new Uint8Array();

    return {
      url: current.toString(),
      status: response.status,
      ok: response.ok,
      contentType,
      bytes,
      byteLength: bytes.byteLength,
    };
  }
}
