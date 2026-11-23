import type { EmbedGemmaDimensions, EmbedGemmaResult, NodeModelCacheSnapshot } from '@flaxia/sdk';
import { MAX_EMBED_GEMMA_TOKENS } from '@flaxia/sdk';
import {
  FRIEDFLAXIA_EMBED_GEMMA,
  downloadPinnedModel,
} from './model-registry';
import { initFriedFlaxiaWasm } from '../../vendor/friedflaxia/init';
import type { FriedFlaxiaModel } from '../../vendor/friedflaxia/types';

export type { FriedFlaxiaModel } from '../../vendor/friedflaxia/types';

let model: FriedFlaxiaModel | null = null;
let modelLoad: Promise<FriedFlaxiaModel> | null = null;

export async function loadFriedFlaxiaModel(): Promise<FriedFlaxiaModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  const loadStartedAt = performance.now();
  modelLoad = (async () => {
    const wasmStartedAt = performance.now();
    await initFriedFlaxiaWasm();
    const wasmMs = performance.now() - wasmStartedAt;
    const downloadStartedAt = performance.now();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_EMBED_GEMMA);
    const downloadMs = performance.now() - downloadStartedAt;
    const constructStartedAt = performance.now();
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded: FriedFlaxiaModel = new Model(bytes);
    const constructMs = performance.now() - constructStartedAt;
    console.log(
      `[flaxia-node:worker] model load modelId=${FRIEDFLAXIA_EMBED_GEMMA.modelId} bytes=${bytes.byteLength} ` +
        `wasmMs=${Math.round(wasmMs)} downloadMs=${Math.round(downloadMs)} constructMs=${Math.round(constructMs)} ` +
        `totalMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    model = loaded;
    return loaded;
  })().catch((error) => {
    modelLoad = null;
    throw error;
  });
  return modelLoad;
}

export const releaseCache = (): void => {
  const current = model;
  model = null;
  modelLoad = null;
  try {
    current?.free();
  } catch {}
};

/** Whether the text encoder is resident, for the coordinator's warm placement. */
export const isEmbedGemmaLoaded = (): boolean => model !== null;

/** Cache snapshot entry for the resident text encoder (empty when cold). */
export function getEmbedGemmaCacheSnapshot(): NodeModelCacheSnapshot {
  const sampledAt = Date.now();
  return {
    version: 1,
    sampledAt,
    expiresAt: sampledAt + 60_000,
    entries: isEmbedGemmaLoaded()
      ? [
          {
            modelId: FRIEDFLAXIA_EMBED_GEMMA.modelId,
            revision: FRIEDFLAXIA_EMBED_GEMMA.revision,
            dtype: 'q8_0',
            backend: 'wasm',
            state: 'ready',
            referenceCount: 1,
          },
        ]
      : [],
  };
}

/** Matryoshka truncation requires re-normalising the prefix. */
export function truncateAndNormalize(vector: number[], dimensions: number): number[] {
  const out = vector.slice(0, dimensions);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  return out.map((value) => value / norm);
}

/** Embed one or more texts with an already-loaded model. */
export async function embedTexts(
  loaded: FriedFlaxiaModel,
  texts: string[],
  dimensions: number,
  onBatch?: () => void | Promise<void>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  const eos = loaded.eos_token_id?.();
  for (const text of texts) {
    const ids = limitTokenIds(loaded.encode(text, true), eos);
    const embedding = loaded.embed(ids);
    if (embedding.length !== FRIEDFLAXIA_EMBED_GEMMA.dimensions) {
      throw new Error(
        `friedflaxia: expected ${FRIEDFLAXIA_EMBED_GEMMA.dimensions} embedding values, got ${embedding.length}`,
      );
    }
    vectors.push(truncateAndNormalize(Array.from(embedding), dimensions));
  }
  await onBatch?.();
  return vectors;
}

/**
 * Bound one sequence to the model token budget.
 *
 * The encoder streams its whole weight matrix per layer and attends over every
 * position, so an unbounded post turns into minutes of work. The tail is cut and
 * EOS is restored so mean pooling still sees a terminated sequence.
 */
export function limitTokenIds(
  ids: Uint32Array,
  eos: number | undefined,
  maxTokens: number = MAX_EMBED_GEMMA_TOKENS,
): Uint32Array {
  if (ids.length <= maxTokens) return ids;
  const out = ids.slice(0, maxTokens);
  if (eos !== undefined && out.length > 0) out[out.length - 1] = eos;
  return out;
}

export async function handleFriedFlaxiaEmbedGemma(
  payload: { texts: string[]; dimensions?: EmbedGemmaDimensions },
  onBatch?: () => void | Promise<void>,
): Promise<EmbedGemmaResult> {
  const startedAt = performance.now();
  const dimensions = payload.dimensions ?? (FRIEDFLAXIA_EMBED_GEMMA.dimensions as EmbedGemmaDimensions);
  const loaded = await loadFriedFlaxiaModel();
  const tokens = payload.texts.reduce((sum, text) => sum + text.length, 0);
  const vectors = await embedTexts(loaded, payload.texts, dimensions, onBatch);
  console.log(
    `[flaxia-node:worker] embed-gemma texts=${payload.texts.length} chars=${tokens} ` +
      `dimensions=${dimensions} ms=${Math.round(performance.now() - startedAt)}`,
  );
  return {
    vectors,
    model: FRIEDFLAXIA_EMBED_GEMMA.modelId,
    dimensions,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
