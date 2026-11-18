/**
 * Pinned model download for the FriedFlaxia EmbeddingGemma backend.
 *
 * Unlike `ai-inference` payloads, these URLs never come from a task. They are
 * compile-time constants, pinned to an immutable revision, and the node only
 * accepts the exact SHA-256 listed here.
 */
export const FRIEDFLAXIA_EMBED_GEMMA = {
  modelId: 'google/embeddinggemma-2',
  repo: 'unsloth/embeddinggemma-2-GGUF',
  revision: '031f0d4b35536f69ab3509d4893c923264fcf253',
  file: 'embeddinggemma-2-Q8_0.gguf',
  url: 'https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/embeddinggemma-2-Q8_0.gguf',
  sha256: '6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc',
  maxBytes: 320 * 1024 * 1024,
  dimensions: 768,
} as const;

/** Reject an oversized response before materializing its body. */
export function assertModelSize(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error('friedflaxia: model response has no usable Content-Length');
  }
  if (byteLength > FRIEDFLAXIA_EMBED_GEMMA.maxBytes) {
    throw new Error(
      `friedflaxia: model file too large (${byteLength} > ${FRIEDFLAXIA_EMBED_GEMMA.maxBytes})`,
    );
  }
}

/** Lowercase hex SHA-256 of the model bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
