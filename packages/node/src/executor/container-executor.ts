import { WASI, File, Directory, PreopenDirectory } from "@bjorn3/browser_wasi_shim";
import type { ContainerPayload, ContainerResult } from "@flaxia/sdk";
import { assertPublicUrl, fetchGuarded } from "./egress-guard";

/**
 * Origins allowed to serve container WASM images.
 *
 * Fail closed: the default is EMPTY, which means every `container` task is
 * rejected until an operator opts in. A `container` task names an arbitrary
 * `https://…/*.wasm` URL, and fetching it means executing code from a host the
 * submitter chose — so the operator must decide which registries are trusted
 * (see `docs/04-workloads.md`).
 */
let allowedImageOrigins: readonly string[] = [];

/** Maximum size of a container WASM image (128 MiB). */
export const MAX_CONTAINER_IMAGE_BYTES = 128 * 1024 * 1024;

/** Content types a container image may be served with. */
const CONTAINER_IMAGE_CONTENT_TYPES = ['application/wasm', 'application/octet-stream'] as const;

/** Memory bounds for `memoryLimitMb` (clamped): 32 MiB .. 4 GiB. */
export const MIN_CONTAINER_MEMORY_MB = 32;
export const MAX_CONTAINER_MEMORY_MB = 4096;
/** Default memory cap when the payload omits `memoryLimitMb`. */
export const DEFAULT_CONTAINER_MEMORY_MB = 512;

const WASM_PAGE_SIZE = 65536;

/** Origin of a URL, e.g. `https://cdn.example.com` (empty when unparseable). */
function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * Replace the container image origin allowlist. Hosts/operators call this once
 * at start-up; entries must be exact origins (`https://cdn.example.com`).
 */
export function configureContainerImageOrigins(origins: readonly string[]): void {
  const normalized: string[] = [];
  for (const entry of origins) {
    const origin = originOf(entry);
    if (!origin || origin === 'null') {
      throw new Error(`Invalid container image origin: ${entry}`);
    }
    if (!origin.startsWith('https://')) {
      throw new Error(`Container image origins must use https: ${entry}`);
    }
    if (!normalized.includes(origin)) normalized.push(origin);
  }
  allowedImageOrigins = normalized;
}

/** Origins currently allowed to serve container images (empty = disabled). */
export function getAllowedContainerImageOrigins(): readonly string[] {
  return allowedImageOrigins;
}

/**
 * Validate a container image URL. The origin allowlist is the primary control;
 * the shared egress guard additionally rejects loopback/private hosts,
 * non-default ports, credentials, non-HTTPS schemes and non-`.wasm` paths.
 */
export function validateImageUrl(urlStr: string): URL {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid image URL: ${urlStr}`);
  }

  if (allowedImageOrigins.length === 0) {
    throw new Error(
      'container workload disabled: no container image origins are configured (set containerImageOrigins on the node host)',
    );
  }

  if (!allowedImageOrigins.includes(url.origin)) {
    throw new Error(`Container image origin not allowed: ${url.origin}`);
  }

  if (!url.pathname.endsWith('.wasm')) {
    throw new Error(`Image URL must point to a .wasm file: ${url.pathname}`);
  }

  // Credentials, odd ports, loopback/private hosts and non-HTTPS schemes are
  // rejected here too: an operator allowlist entry must never widen the guard.
  return assertPublicUrl(url);
}

export interface WasmMemoryLimits {
  /** Declared minimum memory in bytes (0 when the module does not declare any). */
  initialBytes: number;
  /** Declared maximum memory in bytes, or null when the module declares none. */
  maximumBytes: number | null;
}

/**
 * Read the memory section of a WASM binary.
 *
 * A WASI module exports its own `WebAssembly.Memory`, so the shim cannot inject
 * a capped memory: the only pre-execution guarantee available in the browser is
 * to inspect what the module *declares* and refuse to instantiate when it is
 * allowed to exceed `memoryLimitMb`. See `docs/04-workloads.md` for the exact
 * guarantee this does (and does not) provide.
 */
export function parseWasmMemoryLimits(binary: Uint8Array): WasmMemoryLimits {
  if (binary.byteLength < 8) throw new Error('Invalid WASM image: truncated header');
  if (binary[0] !== 0x00 || binary[1] !== 0x61 || binary[2] !== 0x73 || binary[3] !== 0x6d) {
    throw new Error('Invalid WASM image: bad magic number');
  }
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  if (view.getUint32(4, true) !== 1) {
    throw new Error('Unsupported WASM image version');
  }

  let offset = 8;
  while (offset < binary.byteLength) {
    const sectionId = binary[offset++];
    const size = readULEB128(binary, offset);
    offset = size.next;
    const sectionEnd = offset + size.value;
    if (sectionEnd > binary.byteLength) throw new Error('Invalid WASM image: truncated section');

    if (sectionId === 5) {
      // Memory section: a vector of limits. The payload may declare several
      // memories; the largest declared limit is the one that can hurt us.
      let cursor = offset;
      const count = readULEB128(binary, cursor);
      cursor = count.next;
      let initialBytes = 0;
      let maximumBytes: number | null = null;
      for (let i = 0; i < count.value; i++) {
        const flags = readULEB128(binary, cursor);
        cursor = flags.next;
        const initialPages = readULEB128(binary, cursor);
        cursor = initialPages.next;
        const shared = (flags.value & 0x2) !== 0;
        const hasMaximum = (flags.value & 0x1) !== 0 || shared;
        let maxPages: number | null = null;
        if (hasMaximum) {
          const maximum = readULEB128(binary, cursor);
          cursor = maximum.next;
          maxPages = maximum.value;
        }
        if (cursor > sectionEnd) throw new Error('Invalid WASM image: malformed memory section');
        initialBytes = Math.max(initialBytes, initialPages.value * WASM_PAGE_SIZE);
        if (maxPages !== null) {
          const bytes = maxPages * WASM_PAGE_SIZE;
          maximumBytes = maximumBytes === null ? bytes : Math.max(maximumBytes, bytes);
        }
      }
      return { initialBytes, maximumBytes };
    }
    offset = sectionEnd;
  }
  return { initialBytes: 0, maximumBytes: null };
}

function readULEB128(binary: Uint8Array, start: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    if (offset >= binary.byteLength) throw new Error('Invalid WASM image: truncated LEB128 value');
    const byte = binary[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: offset };
    shift += 7;
    if (shift > 28) throw new Error('Invalid WASM image: oversized LEB128 value');
  }
}

/** Clamp `memoryLimitMb` into the supported range. */
export function resolveMemoryLimitMb(requested?: number): number {
  const value = requested ?? DEFAULT_CONTAINER_MEMORY_MB;
  if (!Number.isFinite(value)) {
    throw new Error(`memoryLimitMb must be a finite number, got ${String(requested)}`);
  }
  return Math.min(MAX_CONTAINER_MEMORY_MB, Math.max(MIN_CONTAINER_MEMORY_MB, Math.floor(value)));
}

/**
 * Enforce the payload's memory cap against the module's declared memory limits.
 * Rejects a module without an explicit maximum, one that could grow past the
 * cap, or one that needs more than the cap just to start.
 */
export function assertWasmMemoryWithinLimit(binary: Uint8Array, limitMb: number): WasmMemoryLimits {
  const limitBytes = limitMb * 1024 * 1024;
  const limits = parseWasmMemoryLimits(binary);
  if (limits.initialBytes > limitBytes) {
    throw new Error(
      `Container image declares ${Math.round(limits.initialBytes / 1024 / 1024)}MB of initial memory, above memoryLimitMb=${limitMb}`,
    );
  }
  if (limits.maximumBytes === null) {
    throw new Error('Container image has no declared maximum memory; memoryLimitMb cannot be enforced');
  }
  if (limits.maximumBytes > limitBytes) {
    throw new Error(
      `Container image may grow to ${Math.round(limits.maximumBytes / 1024 / 1024)}MB, above memoryLimitMb=${limitMb}`,
    );
  }
  return limits;
}

export const runContainer = async (payload: ContainerPayload): Promise<ContainerResult> => {
  const { image, command, files, memoryLimitMb } = payload;
  const safeImageUrl = validateImageUrl(image);
  const memoryLimit = resolveMemoryLimitMb(memoryLimitMb);

  console.log(`Starting container: ${image} with command: ${command.join(' ')}`);

  // 1. Prepare Filesystem
  const fds: any[] = [];
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];

  // Mock stdout/stderr streams
  const stdout = {
    write: (data: Uint8Array) => {
      stdoutBuffer.push(new TextDecoder().decode(data));
      return data.length;
    }
  };
  const stderr = {
    write: (data: Uint8Array) => {
      stderrBuffer.push(new TextDecoder().decode(data));
      return data.length;
    }
  };

  const rootFiles = new Map<string, any>();
  
  // Map input files
  for (const [path, base64] of Object.entries(files)) {
    const binary = Uint8Array.from(atob(base64 as string), c => c.charCodeAt(0));
    rootFiles.set(path, new File(binary));
  }

  const rootDir = new PreopenDirectory("/", rootFiles);

  // 2. Initialize WASI
  const wasi = new WASI(command, [], [
    // stdin (empty)
    new File(new Uint8Array()),
    // stdout
    { write: stdout.write } as any,
    // stderr
    { write: stderr.write } as any,
    rootDir
  ]);

  // 3. Load and Instantiate WASM (through the shared egress guard: the image URL
  // is customer-supplied, so protocol/host/port/content-type/size are enforced).
  const response = await fetchGuarded({
    url: safeImageUrl,
    allowContentTypes: CONTAINER_IMAGE_CONTENT_TYPES,
    maxBytes: MAX_CONTAINER_IMAGE_BYTES,
  });
  if (!response.ok) {
    throw new Error(`Failed to download container image: ${safeImageUrl.toString()} (HTTP ${response.status})`);
  }
  const wasmBinary = response.bytes;

  // 3b. Enforce `memoryLimitMb` before instantiation: a WASI module exports its
  // own memory, so a module allowed to grow past the cap is rejected instead.
  const limits = assertWasmMemoryWithinLimit(wasmBinary, memoryLimit);
  console.log(
    `[flaxia-node] container: memory cap ${memoryLimit}MB (declared initial=${Math.round(limits.initialBytes / 1024 / 1024)}MB max=${limits.maximumBytes === null ? 'unbounded' : `${Math.round(limits.maximumBytes / 1024 / 1024)}MB`})`,
  );

  const { instance } = (await WebAssembly.instantiate(wasmBinary.slice().buffer, {
    wasi_snapshot_preview1: wasi.wasiImport
  })) as unknown as { instance: WebAssembly.Instance };

  // 4. Run
  try {
    const exitCode = wasi.start(instance as any);
    
    // 5. Collect Output Files (any new files in root)
    const outputFiles: Record<string, string> = {};
    // Note: In a real implementation, we would diff the filesystem or look for specific outputs
    // For now, we collect anything that was modified or added if possible.
    // (Simplified for Phase 1)

    return {
      files: outputFiles,
      stdout: stdoutBuffer.join(''),
      stderr: stderrBuffer.join(''),
      exitCode
    };
  } catch (err) {
    return {
      files: {},
      stdout: stdoutBuffer.join(''),
      stderr: stderrBuffer.join(''),
      exitCode: -1
    };
  }
};
