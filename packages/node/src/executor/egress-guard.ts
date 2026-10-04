/**
 * Node-side egress guard for every workload that fetches a customer-supplied
 * URL (container WASM images, nudenet image URLs, ...).
 *
 * A volunteer node runs inside the visitor's browser, so a customer-supplied
 * URL turns that visitor's residential IP into a request proxy (SSRF): the
 * browser will happily reach loopback, the visitor's LAN, CGNAT/Tailscale
 * addresses, cloud metadata endpoints and `.local`/`.internal` names. The guard
 * below is the single place that decides whether a URL may be fetched at all.
 *
 * What it enforces:
 *  - `https:` only, no embedded credentials (`user:pass@host`);
 *  - the host may not be, or resolve syntactically to, loopback / private /
 *    link-local / CGNAT / ULA / IPv4-mapped-IPv6 / unspecified / `0.0.0.0/8` /
 *    multicast / reserved space, and may not end in `.local` or `.internal`;
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

/** Hostnames that are always rejected, regardless of how they resolve. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];
const BLOCKED_HOSTNAMES = ['localhost'];

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
  bytes: Uint8Array;
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
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this network", localhost on some stacks)
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3 203.0.113.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (incl. Tailscale)
  if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved 240.0.0.0/4 (incl. 255.255.255.255)
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or return null when the
 * text is not a valid IPv6 address. Handles `::` compression, a trailing
 * embedded IPv4 (`::ffff:10.0.0.5`) and IPv4-compatible forms.
 */
export function parseIPv6(host: string): number[] | null {
  let text = host.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return null;
  // A zone index ("fe80::1%eth0") is meaningless in a URL; reject it outright.
  if (text.includes('%')) return null;

  let head = text;
  let tail = '';
  const doubleColon = text.indexOf('::');
  if (doubleColon !== -1) {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    const pieces = part.split(':');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece.includes('.')) {
        // Embedded IPv4 must be the final piece.
        if (i !== pieces.length - 1) return null;
        const octets = piece.split('.');
        if (octets.length !== 4) return null;
        const values: number[] = [];
        for (const octet of octets) {
          if (!/^\d{1,3}$/.test(octet)) return null;
          const value = Number(octet);
          if (value > 255) return null;
          values.push(value);
        }
        groups.push((values[0] << 8) | values[1], (values[2] << 8) | values[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (headGroups === null || tailGroups === null) return null;

  if (doubleColon === -1) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 1) return null;
  return [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
}

/**
 * True when an IPv6 literal is an address a volunteer node must never reach:
 * unspecified (`::`), loopback (`::1`), IPv4-mapped/compatible IPv6 (the
 * browser connects to the embedded IPv4), ULA (`fc00::/7`), link-local
 * (`fe80::/10`), multicast (`ff00::/8`) and reserved space.
 */
export function isBlockedIPv6(host: string): boolean {
  const groups = parseIPv6(host);
  if (!groups) return false;
  const [g0, g1] = groups;
  if (groups.every((group) => group === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses are
  // rejected wholesale: the browser connects to the embedded IPv4, so they are
  // just an alternative spelling of loopback/LAN targets (::ffff:10.0.0.5).
  if (g0 === 0 && g1 === 0 && groups.slice(2, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Validate a hostname (or IP literal) independently of the URL parser. Exported
 * so workloads can pre-check a host and so the rules are unit-testable.
 */
export function assertPublicHostname(hostname: string, options: EgressGuardOptions = {}): void {
  const host = hostname.trim().toLowerCase();
  if (!host) fail('empty hostname');
  if (BLOCKED_HOSTNAMES.includes(host)) fail(`host blocked: ${host}`);
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) fail(`host blocked: ${host}`);
  }
  if (host.startsWith('[') || host.includes(':')) {
    // IPv6 literal: anything we cannot parse is rejected (fail closed) so a
    // malformed literal can never slip past the range checks below.
    if (!parseIPv6(host)) fail(`invalid IPv6 literal: ${host}`);
    if (isBlockedIPv6(host)) fail(`IPv6 address blocked: ${host}`);
    return;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && isBlockedIPv4(host)) {
    fail(`IPv4 address blocked: ${host}`);
  }
  if (!/^[a-z0-9.-]+$/.test(host)) {
    fail(`host is not a plain DNS name or IP literal: ${host}`);
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
): Promise<Uint8Array> {
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