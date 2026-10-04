/**
 * Guards for the NudeNet workload's remote `imageUrl`.
 *
 * The URL comes straight from the task payload, so it is untrusted input: a
 * submitter must not be able to point a viewer's node at its own LAN or at a
 * loopback service, must not be able to make it attach the viewer's credentials,
 * and must not be able to make it buffer an unbounded body.
 */

/** Ceiling on one remote image body; anything larger is refused unread. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Names that always resolve inside the caller's own network. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'] as const;

/** Parse a dotted-quad IPv4 literal into its octets, or null when it is not one. */
function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/** Loopback, private, link-local, CGNAT, multicast and reserved IPv4 space. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224) return true; // multicast, reserved and broadcast space
  return false;
}

/** One IPv6 group string ("1a2b") or an embedded IPv4 tail ("127.0.0.1"). */
function ipv6TailGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups: number[] = [];
  for (const raw of part.split(':')) {
    if (/^[0-9a-f]{1,4}$/.test(raw)) {
      groups.push(parseInt(raw, 16));
      continue;
    }
    const octets = parseIpv4(raw);
    if (!octets) return null;
    groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
  }
  return groups;
}

/** Expand an IPv6 literal into its eight 16-bit groups, or null when invalid. */
function parseIpv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = ipv6TailGroups(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = ipv6TailGroups(halves[1]);
  if (!tail) return null;
  const fill = 8 - head.length - tail.length;
  // "::" has to stand for at least one group, and the halves must fit in eight.
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Loopback, unique-local, link-local, multicast and IPv4-mapped IPv6 space. */
function isPrivateIpv6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses are
  // only as public as the IPv4 address they carry. NAT64 (64:ff9b::/96) is
  // included because carrier IPv6 networks use it to reach IPv4 hosts.
  const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  if (nat64) {
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return false;
}

/**
 * Whether a URL hostname points inside the caller's own network: literal
 * loopback/private addresses (IPv4 and IPv6, including IPv4-mapped forms) and
 * the internal name suffixes `localhost`, `.local` and `.internal`.
 *
 * Unparseable input counts as private (fail closed).
 */
export function isPrivateImageHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1); // absolute/FQDN form
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1); // URL IPv6 form
  if (!host) return true;
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // The WHATWG URL parser normalises every numeric IPv4 form (127.1, 2130706433,
  // 0x7f.1, ...) to a dotted quad, but a caller may hand us a raw hostname, so a
  // numeric-only host that does not parse is still refused.
  if (/^[0-9.]+$/.test(host)) {
    const octets = parseIpv4(host);
    return octets === null || isPrivateIpv4(octets);
  }
  if (host.includes(':')) {
    const groups = parseIpv6(host);
    return groups === null || isPrivateIpv6(groups);
  }
  return false;
}

/**
 * Resolve an `imageUrl` payload field to a URL that is safe to fetch. Rejects
 * non-http(s) schemes and every host that is not routable on the public
 * internet.
 */
export function resolveImageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('imageUrl must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`imageUrl scheme ${url.protocol} is not allowed`);
  }
  if (isPrivateImageHost(url.hostname)) {
    throw new Error('imageUrl must not point at a private or loopback host');
  }
  return url;
}

/** Whether a declared `Content-Length` already exceeds the image limit. */
export function isImageTooLarge(contentLength: string | null, maxBytes = MAX_IMAGE_BYTES): boolean {
  if (contentLength === null) return false;
  const declared = Number(contentLength.trim());
  return Number.isFinite(declared) && declared > maxBytes;
}

/**
 * Read an image response into a Blob, refusing to buffer more than `maxBytes`.
 * The declared length is checked first (so an oversized body is never read), and
 * the stream is counted while it arrives for responses that lie about it.
 */
export async function readImageBlob(response: Response, maxBytes = MAX_IMAGE_BYTES): Promise<Blob> {
  const headers = response.headers;
  if (isImageTooLarge(headers?.get('content-length') ?? null, maxBytes)) {
    throw new Error(`image is larger than the ${maxBytes} byte limit`);
  }

  const body = response.body;
  if (!body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new Error(`image is larger than the ${maxBytes} byte limit`);
    return blob;
  }

  const reader = body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`image is larger than the ${maxBytes} byte limit`);
      }
      // Copy into an owned ArrayBuffer: Blob parts must not be shared-buffer views.
      chunks.push(value.slice().buffer);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  return new Blob(chunks, { type: headers?.get('content-type') ?? '' });
}
