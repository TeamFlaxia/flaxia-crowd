import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../friedflaxia/model-registry';

const { FRIEDFLAXIA_EMBED_GEMMA, assertModelSize, sha256Hex } = registry;

function cachedPath(cacheDir: string, sha256: string): string {
  return join(cacheDir, 'flaxia-models', `${sha256}.bin`);
}

function mockFetch(bytesFor: (url: string) => Uint8Array) {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const bytes = bytesFor(String(url));
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('friedflaxia model registry', () => {
  it('pins an immutable revision, URL and SHA-256', () => {
    expect(FRIEDFLAXIA_EMBED_GEMMA.url).toContain(
      `/resolve/${FRIEDFLAXIA_EMBED_GEMMA.revision}/`,
    );
    expect(FRIEDFLAXIA_EMBED_GEMMA.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(FRIEDFLAXIA_EMBED_GEMMA.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(FRIEDFLAXIA_EMBED_GEMMA.url.startsWith('https://huggingface.co/')).toBe(true);
  });

  it('rejects missing and oversized model responses', () => {
    expect(() => assertModelSize(0)).toThrow(/Content-Length/);
    expect(() => assertModelSize(Number.NaN)).toThrow(/Content-Length/);
    expect(() => assertModelSize(FRIEDFLAXIA_EMBED_GEMMA.maxBytes + 1)).toThrow(/too large/);
    expect(() => assertModelSize(1024)).not.toThrow();
  });
});

describe('friedflaxia pinned model cache (node filesystem)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'flaxia-model-registry-test-'));
    process.env.FLAXIA_MODEL_CACHE_DIR = cacheDir;
    await registry.clearModelCache();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.FLAXIA_MODEL_CACHE_DIR;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('fetches once per sha256 and restores later calls from disk', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/a.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => bytes);

    const first = await registry.downloadPinnedModel(model);
    expect(Array.from(first)).toEqual([0, 1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'follow' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Array.from(await readFile(cachedPath(cacheDir, digest)))).toEqual([...bytes]);

    // The key is the digest, not the URL: a renamed pin with the same bytes
    // must hit the same cache entry without another download.
    const second = await registry.downloadPinnedModel({
      ...model,
      url: 'https://example.test/renamed.gguf',
    });
    expect(Array.from(second)).toEqual([...bytes]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('discards a tampered cache file and re-downloads it', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/tampered.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => bytes);

    await registry.downloadPinnedModel(model);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await writeFile(cachedPath(cacheDir, digest), new Uint8Array([99, 99, 99]));
    const restored = await registry.downloadPinnedModel(model);
    expect(Array.from(restored)).toEqual([...bytes]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Array.from(await readFile(cachedPath(cacheDir, digest)))).toEqual([...bytes]);
  });

  it('never stores an oversized download and never uses an oversized cache file', async () => {
    const oversized = new Uint8Array(2048).fill(7);
    const digest = await sha256Hex(oversized);
    const model = { url: 'https://example.test/large.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => oversized);

    await expect(registry.downloadPinnedModel(model)).rejects.toThrow(/too large/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(stat(cachedPath(cacheDir, digest))).rejects.toThrow();

    // A poisoned cache entry larger than maxBytes must not suppress the fetch.
    await mkdir(join(cacheDir, 'flaxia-models'), { recursive: true });
    await writeFile(cachedPath(cacheDir, digest), oversized);
    await expect(registry.downloadPinnedModel(model)).rejects.toThrow(/too large/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still downloads successfully when the cache cannot be written', async () => {
    // A regular file at the cache-directory path makes mkdir()/writeFile() fail
    // for every user, including root.
    await writeFile(join(cacheDir, 'flaxia-models'), 'not a directory');
    const bytes = new Uint8Array([42]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/unwritable.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => bytes);

    const result = await registry.downloadPinnedModel(model);
    expect(Array.from(result)).toEqual([42]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('supports clearing the whole cache and removing a single entry', async () => {
    const bytesA = new Uint8Array([1]);
    const bytesB = new Uint8Array([2]);
    const digestA = await sha256Hex(bytesA);
    const digestB = await sha256Hex(bytesB);
    const modelA = { url: 'https://example.test/a.bin', sha256: digestA, maxBytes: 1024 };
    const modelB = { url: 'https://example.test/b.bin', sha256: digestB, maxBytes: 1024 };
    const bytesByUrl = new Map([
      [modelA.url, bytesA],
      [modelB.url, bytesB],
    ]);
    const fetchMock = mockFetch((url) => bytesByUrl.get(url) ?? new Uint8Array());

    await registry.downloadPinnedModel(modelA);
    await registry.downloadPinnedModel(modelB);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await registry.removeCachedModel(digestA);
    await expect(stat(cachedPath(cacheDir, digestA))).rejects.toThrow();
    expect(Array.from(await readFile(cachedPath(cacheDir, digestB)))).toEqual([2]);
    await registry.downloadPinnedModel(modelA);
    await registry.downloadPinnedModel(modelB);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await registry.clearModelCache();
    await expect(stat(cachedPath(cacheDir, digestB))).rejects.toThrow();
    await registry.downloadPinnedModel(modelA);
    await registry.downloadPinnedModel(modelB);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('shares one in-flight download between concurrent callers of the same pin', async () => {
    const bytes = new Uint8Array([5, 6]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/concurrent.gguf', sha256: digest, maxBytes: 1024 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = registry.downloadPinnedModel(model);
    const second = registry.downloadPinnedModel(model);
    release?.();
    const results = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => [...result])).toEqual([
      [5, 6],
      [5, 6],
    ]);
  });

  it('keeps rejecting HTTP errors and freshly downloaded sha mismatches', async () => {
    const digest = await sha256Hex(new Uint8Array([1, 2, 3]));
    const model = { url: 'https://example.test/bad.gguf', sha256: digest, maxBytes: 1024 };

    const failure = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', failure);
    await expect(registry.downloadPinnedModel(model)).rejects.toThrow(/HTTP 503/);

    const wrongBytes = new Uint8Array([9, 9, 9]);
    vi.stubGlobal('fetch', mockFetch(() => wrongBytes));
    await expect(registry.downloadPinnedModel(model)).rejects.toThrow(/SHA-256 mismatch/);
    await expect(registry.downloadPinnedModel(model)).rejects.toThrow(/SHA-256 mismatch/);
  });

  it('rejects a non-hex sha before any fetch or filesystem access', async () => {
    const fetchMock = mockFetch(() => new Uint8Array([1]));
    await expect(
      registry.downloadPinnedModel({
        url: 'https://example.test/evil.gguf',
        sha256: '../../evil',
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/sha256/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('friedflaxia pinned model cache (browser backends)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to an in-memory cache without any persistent storage', async () => {
    vi.stubGlobal('process', undefined);
    const bytes = new Uint8Array([7]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/memory.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => bytes);

    const first = await registry.downloadPinnedModel(model);
    const second = await registry.downloadPinnedModel(model);
    expect(Array.from(second)).toEqual([...first]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await registry.clearModelCache();
    await registry.downloadPinnedModel(model);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses Cache Storage when process is unavailable but caches exists', async () => {
    vi.stubGlobal('process', undefined);
    const store = new Map<string, Response>();
    const open = vi.fn(async () => ({
      match: async (key: string) => store.get(key),
      put: async (key: string, response: Response) => {
        store.set(key, response.clone());
      },
      delete: async (key: string) => store.delete(key),
    }));
    const deleteCache = vi.fn(async () => {
      store.clear();
      return true;
    });
    vi.stubGlobal('caches', { open, delete: deleteCache });

    const bytes = new Uint8Array([8]);
    const digest = await sha256Hex(bytes);
    const model = { url: 'https://example.test/cache-storage.gguf', sha256: digest, maxBytes: 1024 };
    const fetchMock = mockFetch(() => bytes);

    await registry.downloadPinnedModel(model);
    await registry.downloadPinnedModel(model);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalled();
    expect(store.size).toBe(1);

    await registry.removeCachedModel(digest);
    expect(store.size).toBe(0);
    await registry.downloadPinnedModel(model);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
