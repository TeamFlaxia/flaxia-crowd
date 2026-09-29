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
  reset(): void;
  embedRun(token: number, pos: number): Promise<Float32Array>;
  runHidden(hidden: Float32Array, pos: number): Promise<Float32Array>;
  headFromHidden(hidden: Float32Array): Promise<Float32Array>;
  setHidden(hidden: Float32Array): void;
  dispose?(): void;
}

export interface PooledEngineModule {
  Qwen35Engine: { create(config: PooledEngineSliceConfig): Promise<RawPooledEngine> };
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

/** Wrap a raw Pooled engine slice in the stable adapter surface. */
export function wrapPooledEngine(engine: RawPooledEngine): SwarmEngineAdapter {
  return {
    get dim() {
      return engine.dims.dim;
    },
    get nc() {
      return engine.NC;
    },
    reset: () => engine.reset(),
    embedRun: (token, pos) => engine.embedRun(token, pos),
    runHidden: (hidden, pos) => engine.runHidden(hidden, pos),
    headFromHidden: (hidden) => engine.headFromHidden(hidden),
    setHidden: (hidden) => engine.setHidden(hidden),
    dispose: () => engine.dispose?.(),
  };
}
