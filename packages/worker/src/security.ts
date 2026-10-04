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

export async function signPayload(secret: string, body: string): Promise<string> {
  return hmacSha256B64(secret, body);
}

export function safeEqual(a: string, b: string): boolean {
  return constantTimeEqual(a, b);
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

export const NODE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
    if (typeof payload.siteId !== 'string' || !payload.nodeId) return null;
    if (!Array.isArray(payload.capabilities)) return null;
    return payload;
  } catch {
    return null;
  }
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

/**
 * Parse an IPv6 literal (brackets already stripped) into its eight 16-bit
 * groups, or null when the text is not a valid address. Both the compressed
 * (`::ffff:7f00:1`) and expanded (`0:0:0:0:0:0:0:1`) forms are accepted, as is
 * an embedded dotted-quad tail.
 */
function parseIPv6(host: string): number[] | null {
  const h = host.toLowerCase();
  if (!h.includes(':')) return null;

  const halves = h.split('::');
  if (halves.length > 2) return null;

  const groupsOf = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group === '') return null;
      if (group.includes('.')) {
        // A dotted-quad tail is only legal as the last group.
        if (i !== groups.length - 1) return null;
        const ip = parseIPv4(group);
        if (ip === null) return null;
        out.push((ip >>> 16) & 0xffff, ip & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = groupsOf(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = groupsOf(halves[1]);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  // `::` has to stand for at least one zero group.
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function isPrivateIPv6(host: string): boolean {
  const groups = parseIPv6(host);
  // An address we cannot parse is not known to be public.
  if (!groups) return true;

  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // `::`, `::1` and the IPv4-mapped / IPv4-compatible forms share a zero
  // prefix and end in an IPv4 address: that address decides.
  const hasIPv4Tail =
    groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff);
  if (!hasIPv4Tail) return false;
  return isPrivateIPv4(((groups[6] << 16) | groups[7]) >>> 0);
}

function isSafeHostname(hostname: string): boolean {
  // `URL.hostname` keeps the brackets of an IPv6 literal (`[::1]`), so they have
  // to go before anything looks at the address.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host === '0.0.0.0') return false;
  if (/.+\.(local|internal)$/.test(host) || /\.internal\./.test(host)) return false;
  if (host.endsWith('.localhost')) return false;

  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return !isPrivateIPv4(ipv4);

  // Only an IPv6 literal can contain a colon in a hostname.
  if (host.includes(':')) return !isPrivateIPv6(host);

  return true;
}

export function validateCallbackUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') {
    return isSafeHostname(url.hostname) ? url.toString() : null;
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return url.toString();
    }
  }
  return null;
}
