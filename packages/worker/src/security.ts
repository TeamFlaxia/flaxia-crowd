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
