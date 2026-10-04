import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONTAINER_MEMORY_MB,
  MAX_CONTAINER_MEMORY_MB,
  MAX_CONTAINER_IMAGE_BYTES,
  MIN_CONTAINER_MEMORY_MB,
  assertWasmMemoryWithinLimit,
  configureContainerImageOrigins,
  getAllowedContainerImageOrigins,
  parseWasmMemoryLimits,
  resolveMemoryLimitMb,
  runContainer,
  validateImageUrl,
} from '../container-executor';

const WASM_PAGE_SIZE = 65536;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

/** A WASM binary whose memory section declares `initialPages`/`maxPages`. */
function wasmWithMemory(initialPages: number, maxPages: number | null): Uint8Array {
  const limits = [maxPages === null ? 0x00 : 0x01, ...uleb(initialPages)];
  if (maxPages !== null) limits.push(...uleb(maxPages));
  const section = [...uleb(1), ...limits]; // vector count=1, then the limits entry
  const body = [...WASM_MAGIC, 0x05, ...uleb(section.length), ...section];
  return new Uint8Array(body);
}

const MB = 1024 * 1024;

afterEach(() => {
  configureContainerImageOrigins([]);
});

describe('container image origin allowlist (#11)', () => {
  it('rejects every container task while no origin is configured (fail closed)', () => {
    expect(getAllowedContainerImageOrigins()).toEqual([]);
    expect(() => validateImageUrl('https://cdn.example.com/tool.wasm')).toThrow(
      /container workload disabled/,
    );
  });

  it('rejects an origin that was not opted in', () => {
    configureContainerImageOrigins(['https://cdn.example.com']);
    expect(() => validateImageUrl('https://evil.example/payload.wasm')).toThrow(
      /origin not allowed: https:\/\/evil\.example/,
    );
  });

  it('accepts an opted-in origin and still requires a .wasm path', () => {
    configureContainerImageOrigins(['https://cdn.example.com']);
    expect(validateImageUrl('https://cdn.example.com/tool.wasm').pathname).toBe('/tool.wasm');
    expect(() => validateImageUrl('https://cdn.example.com/tool.zip')).toThrow(/must point to a \.wasm/);
  });

  it('rejects non-https or unparseable origins at configuration time', () => {
    expect(() => configureContainerImageOrigins(['http://cdn.example.com'])).toThrow(/must use https/);
    expect(() => configureContainerImageOrigins(['not-an-origin'])).toThrow(/Invalid container image origin/);
  });

  it('rejects the issue #12 bypass forms even for an opted-in-looking URL', () => {
    const bypasses = [
      'https://[fd00::1]/payload.wasm',
      'https://[::ffff:10.0.0.5]/payload.wasm',
      'https://0.2.0.1/payload.wasm',
      'https://[::]/payload.wasm',
      'https://100.100.1.42/payload.wasm',
      'https://127.0.0.1/payload.wasm',
      'https://169.254.169.254/latest/meta-data.wasm',
      'https://metadata.internal/payload.wasm',
      'https://cdn.example.com:8443/payload.wasm',
      'https://user:pass@cdn.example.com/payload.wasm',
    ];
    // Even an allowlist that (mistakenly) contains the private origin cannot
    // make the guard fetch it: the URL check runs on top of the allowlist.
    for (const url of bypasses) {
      expect(() => {
        configureContainerImageOrigins(['https://cdn.example.com']);
        validateImageUrl(url);
      }, url).toThrow();
    }
  });
});

describe('container memoryLimitMb enforcement (#10-4)', () => {
  it('clamps the requested limit into the supported range', () => {
    expect(resolveMemoryLimitMb(undefined)).toBe(DEFAULT_CONTAINER_MEMORY_MB);
    expect(resolveMemoryLimitMb(1)).toBe(MIN_CONTAINER_MEMORY_MB);
    expect(resolveMemoryLimitMb(999_999)).toBe(MAX_CONTAINER_MEMORY_MB);
    expect(resolveMemoryLimitMb(256.9)).toBe(256);
    expect(() => resolveMemoryLimitMb(Number.NaN)).toThrow(/finite number/);
  });

  it('reads the declared memory section', () => {
    const limits = parseWasmMemoryLimits(wasmWithMemory(16, 32));
    expect(limits.initialBytes).toBe(16 * WASM_PAGE_SIZE);
    expect(limits.maximumBytes).toBe(32 * WASM_PAGE_SIZE);
  });

  it('reports a module without a declared maximum', () => {
    const limits = parseWasmMemoryLimits(wasmWithMemory(1, null));
    expect(limits.initialBytes).toBe(WASM_PAGE_SIZE);
    expect(limits.maximumBytes).toBeNull();
  });

  it('rejects a module that may grow past memoryLimitMb', () => {
    // 64 MiB max against a 32 MiB cap.
    expect(() => assertWasmMemoryWithinLimit(wasmWithMemory(1, 1024), 32)).toThrow(
      /may grow to 64MB, above memoryLimitMb=32/,
    );
  });

  it('rejects a module whose initial memory already exceeds the cap', () => {
    expect(() => assertWasmMemoryWithinLimit(wasmWithMemory(1024, 1024), 32)).toThrow(
      /declares 64MB of initial memory/,
    );
  });

  it('accepts a module inside the cap', () => {
    expect(() => assertWasmMemoryWithinLimit(wasmWithMemory(1, 256), 32)).not.toThrow();
  });

  it('rejects a malformed image instead of instantiating it', () => {
    expect(() => parseWasmMemoryLimits(new Uint8Array([1, 2, 3]))).toThrow(/truncated header/);
    expect(() => parseWasmMemoryLimits(new Uint8Array([9, 9, 9, 9, 1, 0, 0, 0]))).toThrow(/bad magic/);
  });

  it('never instantiates a module that exceeds the cap', async () => {
    configureContainerImageOrigins(['https://cdn.example.com']);
    const oversized = wasmWithMemory(1, 4096); // 256 MiB max
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(oversized, { status: 200, headers: { 'content-type': 'application/wasm' } }),
    );
    const instantiateSpy = vi.spyOn(WebAssembly, 'instantiate');

    await expect(
      runContainer({ image: 'https://cdn.example.com/tool.wasm', command: ['true'], files: {}, memoryLimitMb: 32 }),
    ).rejects.toThrow(/above memoryLimitMb=32/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(instantiateSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
    instantiateSpy.mockRestore();
  });

  it('refuses to fetch an image from a host outside the allowlist', async () => {
    configureContainerImageOrigins(['https://cdn.example.com']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      runContainer({ image: 'https://evil.example/payload.wasm', command: ['true'], files: {} }),
    ).rejects.toThrow(/origin not allowed/);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('caps the container image download size', () => {
    expect(MAX_CONTAINER_IMAGE_BYTES).toBe(128 * 1024 * 1024);
  });
});