import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_EGRESS_BYTES,
  MAX_EGRESS_REDIRECTS,
  assertPublicHostname,
  assertPublicUrl,
  fetchGuarded,
  isBlockedIPv4,
  isBlockedIPv6,
  parseIPv6,
} from '../egress-guard';

/** Hosts listed as bypasses in issue #12 (plus the obvious neighbours). */
const BLOCKED_HOSTS = [
  // loopback / private IPv4 (the old BLOCKED_HOSTS list)
  '127.0.0.1',
  '10.0.0.5',
  '172.16.0.1',
  '192.168.1.1',
  // unique local addresses (IPv6 ULA)
  '[fd00:abcd::1]',
  'fd00:abcd::1',
  'fc00::1',
  // IPv4-mapped / IPv4-compatible IPv6
  '[::ffff:10.0.0.5]',
  '[::ffff:127.0.0.1]',
  '::ffff:10.0.0.5',
  // 0.0.0.0/8 (behaves like localhost on some stacks)
  '0.2.0.1',
  '0.0.0.0',
  // unspecified IPv6
  '[::]',
  '::',
  // CGNAT / Tailscale
  '100.100.1.42',
  '100.64.0.1',
  // link-local + metadata
  '169.254.169.254',
  '[fe80::1]',
  // multicast / reserved
  '224.0.0.1',
  '255.255.255.255',
  '[ff02::1]',
  // names
  'localhost',
  'foo.local',
  'metadata.internal',
  'service.home.arpa',
];

const ALLOWED_HOSTS = [
  'example.com',
  'cdn.jsdelivr.net',
  'huggingface.co',
  '8.8.8.8',
  '1.1.1.1',
  '[2606:4700:4700::1111]',
];

describe('egress guard host rules', () => {
  it.each(BLOCKED_HOSTS)('rejects %s', (host) => {
    expect(() => assertPublicHostname(host)).toThrow(/Egress blocked/);
  });

  it.each(ALLOWED_HOSTS)('allows %s', (host) => {
    expect(() => assertPublicHostname(host)).not.toThrow();
  });

  it('classifies IPv4 ranges explicitly', () => {
    expect(isBlockedIPv4('0.2.0.1')).toBe(true);
    expect(isBlockedIPv4('100.100.1.42')).toBe(true);
    expect(isBlockedIPv4('100.63.255.255')).toBe(false);
    expect(isBlockedIPv4('100.128.0.1')).toBe(false);
    expect(isBlockedIPv4('192.0.0.1')).toBe(true);
    expect(isBlockedIPv4('198.18.0.1')).toBe(true);
    expect(isBlockedIPv4('198.51.100.7')).toBe(true);
    expect(isBlockedIPv4('203.0.113.9')).toBe(true);
    expect(isBlockedIPv4('8.8.8.8')).toBe(false);
  });

  it('expands IPv6 literals including compressed and mapped forms', () => {
    expect(parseIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:10.0.0.5')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0005]);
    expect(parseIPv6('[fd00::1]')).toEqual([0xfd00, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('2606:4700:4700::1111')).toEqual([0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111]);
    expect(parseIPv6('not-an-ip')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
  });

  it('rejects malformed IPv6 literals instead of passing them through', () => {
    expect(isBlockedIPv6('1:2:3:4:5:6:7')).toBe(false); // unparseable
    expect(() => assertPublicHostname('[1:2:3:4:5:6:7]')).toThrow(/invalid IPv6 literal/);
  });
});

describe('egress guard URL rules', () => {
  it('allows a plain https URL on the default port', () => {
    const url = assertPublicUrl('https://cdn.example.com/image.png');
    expect(url.hostname).toBe('cdn.example.com');
  });

  it('rejects http, credentials, odd ports and non-URLs', () => {
    expect(() => assertPublicUrl('http://example.com/a.png')).toThrow(/protocol not allowed/);
    expect(() => assertPublicUrl('https://user:pass@example.com/a.png')).toThrow(/credentials/);
    expect(() => assertPublicUrl('https://example.com:8443/a.png')).toThrow(/port not allowed/);
    expect(() => assertPublicUrl('not a url')).toThrow(/invalid URL/);
  });

  it('accepts an explicit default port', () => {
    expect(() => assertPublicUrl('https://example.com:443/a.png')).not.toThrow();
  });

  it('rejects every issue #12 bypass form through the URL parser', () => {
    for (const host of BLOCKED_HOSTS) {
      const literal = host.includes(':') || host.startsWith('[') ? host : host;
      const url = `https://${literal}/payload.wasm`;
      expect(() => assertPublicUrl(url), url).toThrow(/Egress blocked/);
    }
  });
});

describe('fetchGuarded', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
    globalThis.fetch = vi.fn(impl as any) as unknown as typeof fetch;
  }

  it('rejects a blocked host before any request is made', async () => {
    const spy = vi.fn();
    stubFetch(spy as any);

    await expect(
      fetchGuarded({ url: 'https://100.100.1.42/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(/Egress blocked/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the body of an allowed response', async () => {
    stubFetch(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/wasm' },
      }),
    );

    const result = await fetchGuarded({
      url: 'https://cdn.example.com/payload.wasm',
      allowContentTypes: ['application/wasm'],
    });

    expect(result.ok).toBe(true);
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(result.contentType).toBe('application/wasm');
  });

  it('rejects a disallowed Content-Type', async () => {
    stubFetch(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(/content-type not allowed: text\/html/);
  });

  it('rejects a missing Content-Type (fail closed)', async () => {
    stubFetch(async () => new Response(new Uint8Array([1]), { status: 200 }));

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(/content-type not allowed: \(missing\)/);
  });

  it('rejects a body larger than the cap even without Content-Length', async () => {
    // A stream that keeps producing chunks: only the byte counter can stop it.
    const chunk = new Uint8Array(64);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    stubFetch(async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'application/wasm' } }),
    );

    await expect(
      fetchGuarded({
        url: 'https://cdn.example.com/big.wasm',
        allowContentTypes: ['application/wasm'],
        maxBytes: 256,
      }),
    ).rejects.toThrow(/response too large/);
  });

  it('rejects a declared Content-Length above the cap before reading', async () => {
    stubFetch(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'application/wasm', 'content-length': String(64 * 1024 * 1024) },
      }),
    );

    await expect(
      fetchGuarded({
        url: 'https://cdn.example.com/big.wasm',
        allowContentTypes: ['application/wasm'],
        maxBytes: DEFAULT_MAX_EGRESS_BYTES,
      }),
    ).rejects.toThrow(/declares 67108864 bytes/);
  });

  it('re-validates a redirect hop and rejects a private target', async () => {
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(String(url));
      if (String(url).includes('cdn.example.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://10.0.0.5/payload.wasm' },
        });
      }
      return new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'application/wasm' } });
    });

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(/Egress blocked/);
    expect(calls).toHaveLength(1);
  });

  it('follows a validated redirect to a public host', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('cdn.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://files.example.org/payload.wasm' } });
      }
      return new Response(new Uint8Array([7]), { status: 200, headers: { 'content-type': 'application/wasm' } });
    });

    const result = await fetchGuarded({
      url: 'https://cdn.example.com/payload.wasm',
      allowContentTypes: ['application/wasm'],
    });

    expect(result.url).toBe('https://files.example.org/payload.wasm');
    expect(Array.from(result.bytes)).toEqual([7]);
  });

  it('gives up after too many redirects', async () => {
    let hop = 0;
    stubFetch(async () => {
      hop++;
      return new Response(null, { status: 302, headers: { location: `https://cdn.example.com/hop-${hop}.wasm` } });
    });

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(new RegExp(`too many redirects \\(>${MAX_EGRESS_REDIRECTS}\\)`));
  });

  it('rejects an opaque manual redirect it cannot validate', async () => {
    stubFetch(async () => ({ type: 'opaqueredirect', status: 0, headers: new Headers() }) as any);

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/payload.wasm', allowContentTypes: ['application/wasm'] }),
    ).rejects.toThrow(/redirect could not be validated/);
  });

  it('fails closed when no Content-Type allowlist is configured', async () => {
    stubFetch(async () => new Response(new Uint8Array([1]), { status: 200 }));

    await expect(
      fetchGuarded({ url: 'https://cdn.example.com/x.wasm', allowContentTypes: [] }),
    ).rejects.toThrow(/no Content-Type allowlist/);
  });

  it('passes an abort signal and manual redirect mode to fetch', async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'application/wasm' } }),
    );
    stubFetch(spy as any);

    await fetchGuarded({ url: 'https://cdn.example.com/x.wasm', allowContentTypes: ['application/wasm'] });

    expect(spy).toHaveBeenCalledWith(
      'https://cdn.example.com/x.wasm',
      expect.objectContaining({ redirect: 'manual', credentials: 'omit' }),
    );
    const init = spy.mock.calls[0]![1] as unknown as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
