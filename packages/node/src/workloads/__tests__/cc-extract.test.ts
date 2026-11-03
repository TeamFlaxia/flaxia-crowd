import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCcExtract } from '../cc-extract';

const WARC_URL = 'https://example.com/article';
const WARC_PATH =
  'crawl-data/CC-MAIN-2026-43/segments/1700000000000.0/warc/CC-MAIN-20260101000000-20260101010000-00000.warc.gz';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function buildWarc(options: {
  target?: string;
  status?: number;
  contentType?: string;
  body?: string;
  warcType?: string;
  extraHeaders?: string;
} = {}): Uint8Array {
  const target = options.target ?? WARC_URL;
  const warcType = options.warcType ?? 'response';
  const status = options.status ?? 200;
  const contentType = options.contentType ?? 'text/html; charset=UTF-8';
  const body =
    options.body ??
    '<html lang="ja"><head><title>Example title</title><meta name="description" content="Example description"><link rel="canonical" href="/canonical"><meta property="article:published_time" content="2026-10-01T12:00:00Z"></head><body><nav>nav text</nav><article><h1>Hello</h1><p>本文です。本文です。</p><script>alert(1)</script></article></body></html>';
  const bodyBytes = Buffer.from(body);
  const http = Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status} OK\r\nContent-Type: ${contentType}\r\nContent-Length: ${bodyBytes.length}\r\n\r\n`),
    bodyBytes,
  ]);
  const warc = Buffer.concat([
    Buffer.from(
      `WARC/1.0\r\nWARC-Type: ${warcType}\r\nWARC-Target-URI: ${target}\r\nContent-Type: application/http; msgtype=response\r\nContent-Length: ${http.length}\r\n${options.extraHeaders ?? ''}\r\n`,
    ),
    http,
    Buffer.from('\r\n\r\n'),
  ]);
  return new Uint8Array(warc);
}

function compress(warc: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(warc));
}

function mockFetchForWarc(compressed: Uint8Array): void {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    expect(range).toBe(`bytes=0-${compressed.byteLength - 1}`);
    return new Response(toArrayBuffer(compressed), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    crawl: 'CC-MAIN-2026-43',
    records: [{ url: WARC_URL, warcFilename: WARC_PATH, offset: 0, length: 1000, ...overrides }],
  };
}

describe('cc-extract workload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a WARC range and extracts title, text, language and metadata', async () => {
    const compressed = compress(buildWarc());
    mockFetchForWarc(compressed);

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));

    expect(result.documents).toHaveLength(1);
    const doc = result.documents[0]!;
    expect(doc.error).toBeUndefined();
    expect(doc.httpStatus).toBe(200);
    expect(doc.contentType).toBe('text/html');
    expect(doc.title).toBe('Example title');
    expect(doc.text).toContain('本文です。');
    expect(doc.text).not.toContain('alert(1)');
    expect(doc.excerpt).toBe('Example description');
    expect(doc.lang).toBe('ja');
    expect(doc.publishedAt).toBe('2026-10-01T12:00:00Z');
    expect(doc.canonicalUrl).toBe('https://example.com/canonical');
    expect(doc.targetUri).toBe(WARC_URL);
  });

  it('rejects an invalid WARC object path before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      handleCcExtract(payload({ warcFilename: 'https://evil.example/record.warc.gz' })),
    ).rejects.toThrow(/warcFilename/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a target URI mismatch without accepting the record', async () => {
    const compressed = compress(buildWarc({ target: 'https://other.example/page' }));
    mockFetchForWarc(compressed);

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));
    expect(result.documents[0]!.error).toMatch(/target URI/i);
    expect(result.documents[0]!.title).toBe('');
  });

  it('reports an unsupported content type', async () => {
    const compressed = compress(buildWarc({ contentType: 'image/png' }));
    mockFetchForWarc(compressed);

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));
    expect(result.documents[0]!.error).toMatch(/content type/i);
  });

  it('reports a non-200 HTTP status', async () => {
    const compressed = compress(buildWarc({ status: 404 }));
    mockFetchForWarc(compressed);

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));
    expect(result.documents[0]!.httpStatus).toBe(404);
    expect(result.documents[0]!.error).toMatch(/HTTP 404/i);
  });

  it('fetches through an allowlisted signed range proxy when provided', async () => {
    const compressed = compress(buildWarc());
    const proxyUrl = 'https://flaxia.app/api/crowd/cc-range?path=x&offset=0&length=10&sig=x';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(proxyUrl);
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=0-${compressed.byteLength - 1}`);
      return new Response(toArrayBuffer(compressed), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleCcExtract(
      payload({ length: compressed.byteLength, fetchUrl: proxyUrl }),
      ['https://flaxia.app'],
    );

    expect(result.documents[0]!.error).toBeUndefined();
    expect(result.documents[0]!.title).toBe('Example title');
  });

  it('rejects a range proxy origin that is not allowlisted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleCcExtract(
      payload({ length: 1000, fetchUrl: 'https://evil.example/cc-range' }),
      ['https://flaxia.app'],
    );

    expect(result.documents[0]!.error).toMatch(/origin is not allowed/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('processes multiple records and isolates failures', async () => {
    const compressedGood = compress(buildWarc());
    const compressedBad = compress(buildWarc({ target: 'https://other.example/page' }));
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const compressed = call++ === 0 ? compressedGood : compressedBad;
        return new Response(toArrayBuffer(compressed), {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes 0-${compressed.byteLength - 1}/${compressed.byteLength}`,
          },
        });
      }),
    );

    const result = await handleCcExtract({
      crawl: 'CC-MAIN-2026-43',
      records: [
        { url: WARC_URL, warcFilename: WARC_PATH, offset: 0, length: compressedGood.byteLength },
        { url: WARC_URL, warcFilename: WARC_PATH, offset: 0, length: compressedBad.byteLength },
      ],
    });

    expect(result.documents).toHaveLength(2);
    expect(result.documents[0]!.title).toBe('Example title');
    expect(result.documents[1]!.error).toMatch(/target URI/i);
  });

  it('marks a record truncated when the WARC header says so', async () => {
    const compressed = compress(buildWarc({ extraHeaders: 'WARC-Truncated: length\r\n' }));
    mockFetchForWarc(compressed);

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));

    expect(result.documents[0]!.error).toBeUndefined();
    expect(result.documents[0]!.truncated).toBe(true);
  });

  it('rejects a range response without Content-Range', async () => {
    const compressed = compress(buildWarc());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(toArrayBuffer(compressed), { status: 206 })),
    );

    const result = await handleCcExtract(payload({ length: compressed.byteLength }));

    expect(result.documents[0]!.error).toMatch(/Content-Range/i);
  });

  it('rejects a redirect instead of following it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/warc.gz' } }),
      ),
    );

    const result = await handleCcExtract(payload({ length: 1000 }));

    expect(result.documents[0]!.error).toMatch(/redirect/i);
  });

  it('rejects non-response WARC records', async () => {
    for (const warcType of ['resource', 'revisit']) {
      const compressed = compress(buildWarc({ warcType }));
      mockFetchForWarc(compressed);
      const result = await handleCcExtract(payload({ length: compressed.byteLength }));
      expect(result.documents[0]!.error).toMatch(/unsupported WARC type/i);
    }
  });

  it('rejects a WARC path from a different crawl', async () => {
    await expect(
      handleCcExtract({
        crawl: 'CC-MAIN-2026-39',
        records: [{ url: WARC_URL, warcFilename: WARC_PATH, offset: 0, length: 1000 }],
      }),
    ).rejects.toThrow(/belong to payload\.crawl/i);
  });

  it('rejects non-integer caps instead of disabling them', async () => {
    await expect(
      handleCcExtract({ ...payload(), maxRecordBytes: Number.NaN } as never),
    ).rejects.toThrow(/maxRecordBytes/i);
    await expect(
      handleCcExtract({ ...payload(), timeoutMs: Number.NaN } as never),
    ).rejects.toThrow(/timeoutMs/i);
  });
});
