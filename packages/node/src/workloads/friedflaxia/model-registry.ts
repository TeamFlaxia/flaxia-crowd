/**
 * Pinned model download for the FriedFlaxia backends.
 *
 * Unlike `ai-inference` payloads, these URLs never come from a task. They are
 * compile-time constants mirrored from the Rust crate's `model-manifest.json`
 * by `scripts/sync-friedflaxia.mjs`, and the node only accepts the exact
 * SHA-256 listed there.
 */
import sharedManifest from '../../vendor/friedflaxia/model-manifest.json';

const models = sharedManifest.models;

export const FRIEDFLAXIA_EMBED_GEMMA = models.embeddingGemma;
export const FRIEDFLAXIA_EMBED_GEMMA_MMPROJ = models.embeddingGemmaMmproj;
export const FRIEDFLAXIA_PLAMO = models.plamo;
export const FRIEDFLAXIA_D1 = models.d1;
export const FRIEDFLAXIA_D1_MMPROJ = models.d1Mmproj;
export const FRIEDFLAXIA_NUDENET = models.nudenet;
export const FRIEDFLAXIA_DLLM = models.dllm;

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
