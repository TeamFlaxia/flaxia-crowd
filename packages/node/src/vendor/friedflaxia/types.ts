/**
 * Workload-facing types derived from the wasm-bindgen generated declarations.
 *
 * `friedflaxia_wasm.d.ts` is generated from the Rust source and vendored by
 * `scripts/sync-friedflaxia.mjs`. Defining the workload surfaces as `Pick`s
 * of those classes means a renamed or retyped wasm export fails typecheck
 * instead of being hidden behind an `as unknown as` cast.
 */

import type {
  D1MultimodalModel,
  Model,
  MultimodalModel,
} from './friedflaxia_wasm';

export type FriedFlaxiaModel = Pick<Model, 'encode' | 'embed' | 'free'>;

export type PlamoModel = Pick<Model, 'encode' | 'decode' | 'generate' | 'free'> & {
  /** Incremental PlamoSession; awaits the callback so hosts can throttle. */
  generateStream?: (
    promptIds: Uint32Array,
    maxTokens: number,
    onToken: (token: number) => void | Promise<void>,
  ) => Promise<Uint32Array>;
};

export type D1Model = Pick<
  Model,
  'encode' | 'decision' | 'token_id' | 'bos_token_id' | 'metadata_f32' | 'free'
>;

export type D1MultimodalWasmModel = Pick<
  D1MultimodalModel,
  | 'encode'
  | 'token_id'
  | 'bos_token_id'
  | 'metadata_f32'
  | 'encode_image'
  | 'encode_audio'
  | 'decision'
  | 'free'
>;

export type MultimodalWasmModel = Pick<
  MultimodalModel,
  | 'encode'
  | 'encode_image'
  | 'encode_audio'
  | 'embed'
  | 'bos_token_id'
  | 'eos_token_id'
  | 'free'
>;

export type NudeNetModel = Pick<Model, 'detect' | 'free'>;
