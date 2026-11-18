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

export const FRIEDFLAXIA_PLAMO = {
  modelId: 'TeamFlaxia/plamo-3-translate-0.8b-onnx',
  repo: 'pfnet/plamo-3-translate-0.8b-GGUF',
  revision: '1cf96ae02133958a20074bfdfab76517bb737d00',
  file: 'plamo-3-translate-0.8b-Q4_0.gguf',
  url: 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/1cf96ae02133958a20074bfdfab76517bb737d00/plamo-3-translate-0.8b-Q4_0.gguf',
  sha256: '33deed2822f799de4d15bb03bea1ac40efa7d663d9239ee54cc7f65f5ab92917',
  maxBytes: 560 * 1024 * 1024,
} as const;

export const FRIEDFLAXIA_D1 = {
  modelId: 'LiquidAI/d1-omni-600M',
  repo: 'LiquidAI/d1-omni-600M-GGUF',
  revision: '8eb2d2a1c5404bba8a34a88bd8e159c242197d51',
  file: 'd1-omni-600M-Q8_0.gguf',
  url: 'https://huggingface.co/LiquidAI/d1-omni-600M-GGUF/resolve/8eb2d2a1c5404bba8a34a88bd8e159c242197d51/d1-omni-600M-Q8_0.gguf',
  sha256: 'cd94463f4cac9c700ec6750df8df005bb6846de410e159d1f5e985e1171693d3',
  maxBytes: 450 * 1024 * 1024,
} as const;

export const FRIEDFLAXIA_NUDENET = {
  modelId: 'deepghs/nudenet_onnx',
  repo: 'RemydreScarlet/nudenet-gguf',
  revision: 'd83e0d9f17edfb32fe3c62874620ccc21f12c68d',
  file: 'nudenet-320n-f32.gguf',
  url: 'https://huggingface.co/RemydreScarlet/nudenet-gguf/resolve/d83e0d9f17edfb32fe3c62874620ccc21f12c68d/nudenet-320n-f32.gguf',
  sha256: 'f1d215fde4a0c17d763e39901f176632f898630939e0be7e1420fcadb553ca60',
  maxBytes: 16 * 1024 * 1024,
} as const;

export interface PinnedModel {
  url: string;
  sha256: string;
  maxBytes: number;
}

/** Reject an oversized response before materializing its body. */
export function assertModelSize(
  byteLength: number,
  maxBytes: number = FRIEDFLAXIA_EMBED_GEMMA.maxBytes,
): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    throw new Error('friedflaxia: model response has no usable Content-Length');
  }
  if (byteLength > maxBytes) {
    throw new Error(
      `friedflaxia: model file too large (${byteLength} > ${maxBytes})`,
    );
  }
}

/** Lowercase hex SHA-256 of the model bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Download and verify one pinned model file. */
export async function downloadPinnedModel(model: PinnedModel): Promise<Uint8Array> {
  const response = await fetch(model.url, {
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`friedflaxia: model download failed (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0) {
    assertModelSize(declared, model.maxBytes);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertModelSize(bytes.byteLength, model.maxBytes);
  const digest = await sha256Hex(bytes);
  if (digest !== model.sha256) {
    throw new Error(`friedflaxia: model SHA-256 mismatch (${digest})`);
  }
  return bytes;
}
