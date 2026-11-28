/**
 * Shared hostname / URL safety rules for the worker, the browser node and the
 * requester SDK. This is the single source of truth for egress checks:
 * volunteer nodes fetch customer-supplied URLs and a public-looking name can otherwise
 * turn a visitor's browser into an SSRF proxy.
 *
 * The checks are deliberately syntactic: without a DNS API a hostname that
 * resolves to a private address later cannot be detected here. IP literals and
 * private-looking names are rejected outright, and callers should keep relying
 * on the browser's Private Network Access checks for public DNS names.
 */

/** Names that are never public, regardless of how they resolve. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'] as const;

/**
 * Normalize a host for comparison: lowercase, remove IPv6 brackets and strip a
 * single trailing dot. A fully-qualified DNS name may legitimately end in `.`;
 * leaving it in place would let `localhost.` / `foo.local.` bypass suffix
 * checks in consumers that forget to normalize.
 */
export function normalizeHostname(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** Parse a dotted-decimal IPv4 literal into a 32-bit integer, or `null`. */
export function parseIPv4Address(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let ip = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    ip = (ip << 8) | value;
  }
  return ip >>> 0;
}

/**
 * True when an IPv4 address is not globally routable. Includes loopback,
 * RFC1918, link-local/metadata, CGNAT, ULA-style ranges, documentation and
 * benchmarking networks, multicast and the reserved space.
 */
export function isPrivateIPv4Address(ip: number): boolean {
  const a = ip >>> 24;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT / Tailscale
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** True when a dotted-decimal IPv4 literal is in a blocked range. */
export function isBlockedIPv4Host(host: string): boolean {
  const ip = parseIPv4Address(host);
  return ip !== null && isPrivateIPv4Address(ip);
}

/**
 * Expand an IPv6 literal into eight 16-bit groups, or return `null` when the
 * text is not a literal. Handles `::` compression, embedded IPv4 (mapped and
 * compatible forms) and rejects zone ids.
 */
export function parseIPv6Address(host: string): number[] | null {
  let text = host.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (!text.includes(':')) return null;
  // A zone index ("fe80::1%eth0") is meaningless in a URL.
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
        const ip = parseIPv4Address(piece);
        if (ip === null) return null;
        groups.push((ip >>> 16) & 0xffff, ip & 0xffff);
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
  if (doubleColon === -1) return headGroups.length === 8 ? headGroups : null;
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 1) return null;
  return [...headGroups, ...new Array<number>(fill).fill(0), ...tailGroups];
}

/**
 * True when an IPv6 address is not a safe public destination. Besides the
 * obvious loopback/ULA/link-local/multicast ranges this rejects translation
 * and relay prefixes that can embed a private IPv4 address, the documentation
 * prefix and the whole 2001::/23 special-purpose range (Teredo included).
 */
export function isNonPublicIPv6Address(groups: readonly number[]): boolean {
  if (groups.length !== 8) return true;
  const [g0, g1, g2, g3, g4, g5] = groups;
  if (groups.every((group) => group === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) forms are just
  // alternate spellings of an embedded IPv4 destination: reject them all.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return true; // 2001::/23 (incl. Teredo 2001::/32)
  if (g0 === 0x2002) return true; // 6to4 embeds a possibly private IPv4
  return false;
}

/** True when an IPv6 literal is unparseable or in a blocked range. */
export function isBlockedIPv6Host(host: string): boolean {
  const groups = parseIPv6Address(host);
  return groups === null || isNonPublicIPv6Address(groups);
}

/**
 * Validate a hostname or IP literal independently of the URL parser.
 * A trailing dot is normalized away so DNS-looking bypasses cannot sneak in.
 */
export function isSafePublicHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host || host === 'localhost' || host === '0.0.0.0') return false;
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) return false;
  }
  if (host.includes(':')) {
    // Fail closed: anything that is not a parseable public literal is rejected.
    return !isBlockedIPv6Host(host);
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  return !isBlockedIPv4Host(host);
}

export interface SafeUrlOptions {
  /** Allow `http:` as well as `https:` (never enable for production egress). */
  allowInsecure?: boolean;
  /** Ports accepted in addition to the default HTTPS port 443. */
  allowedPorts?: readonly number[];
}

/** Parse and validate an egress/callback URL; `null` when it is not safe. */
export function isSafePublicUrl(raw: string | URL, options: SafeUrlOptions = {}): URL | null {
  let url: URL;
  try {
    url = raw instanceof URL ? new URL(raw.toString()) : new URL(raw);
  } catch {
    return null;
  }
  const protocols = options.allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!protocols.includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  const ports = options.allowedPorts ?? [443];
  if (url.port && !ports.includes(Number(url.port))) return null;
  if (!isSafePublicHostname(url.hostname)) return null;
  return url;
}
