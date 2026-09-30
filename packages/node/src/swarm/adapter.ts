// Adapter over the Nehanth/pooled engine API (https://github.com/Nehanth/pooled),
// MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
import { probeWebGpu } from '../executor/webgpuProbe';

/**
 * Minimal surface of one Pooled (SwarmLLM) engine slice that a swarm session
 * drives. It mirrors the methods `Qwen35Engine` exposes in the vendored engine
 * (`vendor/pooled/engine/qwen35.js`) so the same adapter works for a host slice
 * (`hasEmbed`/`hasHead`) and a middle slice.
 */
export interface SwarmEngineAdapter {
  readonly dim: number;
  readonly nc: number;
  /** KV cache length of this slice; the session may not exceed it. */
  readonly maxSeq?: number;
  reset(): void;
  /** Embed a single token into a hidden state (host slices only). */
  embedRun(token: number, pos: number): Promise<Float32Array>;
  /** Run a hidden state through this slice's layers. */
  runHidden(hidden: Float32Array, pos: number): Promise<Float32Array>;
  /** Final norm + LM head + logits (host slices only). */
  headFromHidden(hidden: Float32Array): Promise<Float32Array>;
  setHidden(hidden: Float32Array): void;
  dispose(): void;
}

/** Config passed straight through to `Qwen35Engine.create`. */
export interface PooledEngineSliceConfig {
  device: unknown;
  meta: Record<string, unknown>;
  layerRange: [number, number];
  hasEmbed: boolean;
  hasHead: boolean;
  vocab: number;
  maxSeq?: number;
  batchCols?: number;
  weights: unknown;
}

export interface RawPooledEngine {
  dims: { dim: number };
  NC: number;
  maxSeq?: number;
  reset(): void;
  embedRun(token: number, pos: number): Promise<Float32Array>;
  runHidden(hidden: Float32Array, pos: number): Promise<Float32Array>;
  headFromHidden(hidden: Float32Array): Promise<Float32Array>;
  setHidden(hidden: Float32Array): void;
  dispose?(): void;
}

export interface PooledTensorInfo {
  shape: number[];
  byteOffset: number;
  byteLength: number;
  ggmlType: number;
}

export interface PooledGguf {
  meta: Record<string, unknown>;
  tensors: Record<string, PooledTensorInfo>;
  /** Set to stream Q4_0/Q8_0 matrices straight into GPU buffers. */
  streamEntry?: (info: PooledTensorInfo) => Promise<unknown>;
}

export interface PooledTokenizer {
  vocab: Record<string, number>;
  encode(text: string): number[];
  decode(ids: number[]): string;
}

export interface PooledEngineModule {
  Qwen35Engine: { create(config: PooledEngineSliceConfig): Promise<RawPooledEngine> };
  parseGGUFHeader(buffer: ArrayBuffer, options?: { skipTokenizer?: boolean }): PooledGguf;
  qwen35Weights(
    gguf: PooledGguf,
    bytesOf: (info: PooledTensorInfo) => Promise<Uint8Array>,
    options: { lo: number; hi: number; hasEmbed: boolean; hasHead: boolean; mtp?: boolean },
    onProgress?: (bytes: number) => void,
    onEntry?: (entry: unknown, name: string) => void,
  ): Promise<unknown>;
  tokenizerFromGGUF(meta: Record<string, unknown>): unknown;
  makeTokenizer(vocab: unknown): PooledTokenizer;
  argmax(logits: Float32Array): number;
  f32ToF16(value: number): number;
  f16ToF32(value: number): number;
  /** Upload one converted entry with writeBuffer (large matrices cannot use mappedAtCreation). */
  gpuUploadEntry(device: unknown, entry: unknown, keepCpu?: boolean): unknown;
  /** Stream a Q4_0/Q8_0 tensor from a fetch Response straight into GPU buffers. */
  streamEntryToGPU(
    device: unknown,
    info: PooledTensorInfo,
    openRange: (info: PooledTensorInfo) => Promise<Response>,
    options?: { staging?: number },
  ): Promise<unknown>;
  GGML_EMBED: string;
}

export type EngineModuleImporter = (url: string) => Promise<unknown>;

export class SwarmEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmEngineUnavailableError';
  }
}

/**
 * Load the vendored engine module for a node's swarm slice. Fails fast with
 * {@link SwarmEngineUnavailableError} when the context has no WebGPU adapter or
 * the module does not look like the Pooled engine, so a node can report a clean
 * capability failure instead of throwing deep inside an inference loop.
 *
 * The module URL is a runtime string (the engine ships as its own chunk), so the
 * bundler must not try to resolve it statically; the injected importer keeps it
 * testable without a browser.
 */
export async function loadPooledEngineModule(
  moduleUrl: string,
  importer?: EngineModuleImporter,
): Promise<PooledEngineModule> {
  if (!(await probeWebGpu()).webgpu) {
    throw new SwarmEngineUnavailableError('WebGPU is not available in this context');
  }

  const load = importer ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>);
  let mod: unknown;
  try {
    mod = await load(moduleUrl);
  } catch (err) {
    throw new SwarmEngineUnavailableError(
      `failed to load swarm engine module: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const engine = (mod as Partial<PooledEngineModule> | null)?.Qwen35Engine;
  if (!engine || typeof engine.create !== 'function') {
    throw new SwarmEngineUnavailableError(`module at ${moduleUrl} does not export Qwen35Engine.create`);
  }
  return mod as PooledEngineModule;
}

/**
 * Wrap a raw Pooled engine slice in the stable adapter surface.
 *
 * `dispose()` releases the slice's own buffers *and* the GPU device it was
 * created on: the runtime requests a fresh device per session, so leaving it
 * alive would keep the whole model resident in the GPU on a worker that is
 * reused for the next task. Calling it twice is a no-op.
 */
export function wrapPooledEngine(engine: RawPooledEngine, device?: unknown): SwarmEngineAdapter {
  let disposed = false;
  return {
    get dim() {
      return engine.dims.dim;
    },
    get nc() {
      return engine.NC;
    },
    get maxSeq() {
      return engine.maxSeq;
    },
    reset: () => engine.reset(),
    embedRun: (token, pos) => engine.embedRun(token, pos),
    runHidden: (hidden, pos) => engine.runHidden(hidden, pos),
    headFromHidden: (hidden) => engine.headFromHidden(hidden),
    setHidden: (hidden) => engine.setHidden(hidden),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        engine.dispose?.();
      } catch {}
      try {
        (device as { destroy?: () => void } | undefined)?.destroy?.();
      } catch {}
    },
  };
}
