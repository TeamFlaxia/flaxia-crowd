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

export type FriedFlaxiaModel = Pick<Model, 'encode' | 'embed' | 'free'> & {
  /** Present on the vendored build; used to restore EOS after truncation. */
  eos_token_id?: () => number | undefined;
};

export type PlamoModel = Pick<Model, 'encode' | 'decode' | 'generate' | 'free'> &
  /**
   * Incremental PlamoSession. The wasm-bindgen export is `generate_stream`;
   * it awaits the callback so hosts can throttle and cancel between tokens.
   * Bind to the generated declaration so a rename fails typecheck; `Partial`
   * keeps the fallback for older vendored builds.
   */
  Partial<Pick<Model, 'generate_stream'>>;

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

/** Top-k candidates returned by the dLLM denoise step. */
export interface DllmTopKOutput {
  positions: Uint32Array | number[];
  /** Row-major `[positions.len()][topK]`. */
  tokenIds: Uint32Array | number[];
  /** Softmax probabilities aligned with `tokenIds`. */
  probabilities: Float32Array | number[];
  confidence: Float32Array | number[];
  vocabSize: number;
  topK: number;
}

export type DllmModel = Pick<
  Model,
  'encode' | 'decode' | 'token_id' | 'eos_token_id' | 'free' | 'loraRank' | 'loraExpert'
> & {
  /** The wasm binding returns a plain object, so its d.ts type is `any`. */
  denoise_topk(
    tokens: Uint32Array | number[],
    positions: Uint32Array | number[],
    blockStart: number,
    blockEnd: number,
    topK: number,
  ): DllmTopKOutput;
};
