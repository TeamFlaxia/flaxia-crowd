import {
  EMBED_GEMMA_NATIVE_DIMENSIONS,
  MAX_EMBED_GEMMA_TEXT_CHARS,
  MAX_EMBED_GEMMA_TEXTS,
  MAX_EMBED_GEMMA_TOTAL_CHARS,
  isEmbedGemmaDimensions,
  type EmbedGemmaDimensions,
  type EmbedGemmaPayload,
  type EmbedGemmaResult,
} from '@flaxia/sdk';
import { handleFriedFlaxiaEmbedGemma } from './friedflaxia/embed-gemma';

export { releaseCache } from './friedflaxia/embed-gemma';

function fail(message: string): never {
  throw new Error(`embed-gemma: ${message}`);
}

function validatePayload(payload: EmbedGemmaPayload): { texts: string[]; dimensions: EmbedGemmaDimensions } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object');
  const texts = payload.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_GEMMA_TEXTS) {
    fail(`texts must contain 1..${MAX_EMBED_GEMMA_TEXTS} strings`);
  }
  let totalChars = 0;
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) fail('each text must be a non-empty string');
    if (text.length > MAX_EMBED_GEMMA_TEXT_CHARS) {
      fail(`each text must be at most ${MAX_EMBED_GEMMA_TEXT_CHARS} characters`);
    }
    totalChars += text.length;
  }
  if (totalChars > MAX_EMBED_GEMMA_TOTAL_CHARS) fail(`texts exceed ${MAX_EMBED_GEMMA_TOTAL_CHARS} characters in total`);
  const dimensions = payload.dimensions ?? EMBED_GEMMA_NATIVE_DIMENSIONS;
  if (!isEmbedGemmaDimensions(dimensions)) fail(`dimensions must be one of 768, 512, 256, 128`);
  return { texts, dimensions };
}

export async function handleEmbedGemma(
  payload: EmbedGemmaPayload,
  /** Called between model calls so the worker can hold its CPU duty cycle. */
  onBatch?: () => void | Promise<void>,
): Promise<EmbedGemmaResult> {
  const { texts, dimensions } = validatePayload(payload);
  return handleFriedFlaxiaEmbedGemma({ texts, dimensions }, onBatch);
}
