/* tslint:disable */
/* eslint-disable */

export class Model {
    free(): void;
    [Symbol.dispose](): void;
    architecture(): string;
    bos_token_id(): number | undefined;
    decision(token_ids: Uint32Array | number[], marker_positions: Uint32Array | number[], qtype: number): Float32Array;
    decode(ids: Uint32Array | number[]): string;
    detect(input: Float32Array | number[], top_k: number, iou_threshold: number, score_threshold: number): Float32Array;
    embed(token_ids: Uint32Array | number[]): Float32Array;
    embed_text(text: string): Float32Array;
    encode(text: string, add_special_tokens: boolean): Uint32Array;
    eos_token_id(): number | undefined;
    generate(prompt_ids: Uint32Array | number[], max_tokens: number): Uint32Array;
    metadata_f32(key: string): number | undefined;
    metadata_u32(key: string): number | undefined;
    constructor(bytes: Uint8Array | number[]);
    next_token(token_ids: Uint32Array | number[]): number;
    tensor_count(): number;
    token_id(token: string): number | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_model_free: (a: number, b: number) => void;
    readonly model_architecture: (a: number) => [number, number];
    readonly model_bos_token_id: (a: number) => number;
    readonly model_decision: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly model_decode: (a: number, b: number, c: number) => [number, number, number, number];
    readonly model_detect: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly model_embed: (a: number, b: number, c: number) => [number, number, number, number];
    readonly model_embed_text: (a: number, b: number, c: number) => [number, number, number, number];
    readonly model_encode: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly model_eos_token_id: (a: number) => number;
    readonly model_generate: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly model_metadata_f32: (a: number, b: number, c: number) => number;
    readonly model_metadata_u32: (a: number, b: number, c: number) => number;
    readonly model_new: (a: number, b: number) => [number, number, number];
    readonly model_next_token: (a: number, b: number, c: number) => [number, number, number];
    readonly model_tensor_count: (a: number) => number;
    readonly model_token_id: (a: number, b: number, c: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
