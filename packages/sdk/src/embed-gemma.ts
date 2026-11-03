import type { EmbedGemmaDimensions } from './types';

/** ONNX repository loaded by the node (text-only encoders). */
export const EMBED_GEMMA_MODEL = 'onnx-community/embeddinggemma-2-ONNX';
/** Upstream model id reported in results and metadata. */
export const EMBED_GEMMA_HF_MODEL = 'google/embeddinggemma-2';
/** Native output dimension. */
export const EMBED_GEMMA_NATIVE_DIMENSIONS = 768;
/** Maximum texts accepted in one task. */
export const MAX_EMBED_GEMMA_TEXTS = 32;
/** Maximum character budget across all texts in one task. */
export const MAX_EMBED_GEMMA_TOTAL_CHARS = 100_000;
/** Maximum characters accepted for a single text. */
export const MAX_EMBED_GEMMA_TEXT_CHARS = 4_000;
/** Matryoshka truncation sizes supported by the model. */
export const EMBED_GEMMA_DIMENSIONS: readonly EmbedGemmaDimensions[] = [768, 512, 256, 128];

export function isEmbedGemmaDimensions(value: unknown): value is EmbedGemmaDimensions {
  return typeof value === 'number' && (EMBED_GEMMA_DIMENSIONS as readonly number[]).includes(value);
}
