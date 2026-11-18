import type { EmbedGemmaDimensions, EmbedGemmaResult } from '@flaxia/sdk';
import {
  FRIEDFLAXIA_EMBED_GEMMA,
  downloadPinnedModel,
} from './model-registry';

/** Minimal surface of the vendored wasm `Model` used by this workload. */
export interface FriedFlaxiaModel {
  encode(text: string, addSpecialTokens: boolean): Uint32Array;
  embed(tokenIds: Uint32Array): Float32Array;
  free(): void;
}

let wasmReady: Promise<void> | null = null;
let model: FriedFlaxiaModel | null = null;
let modelLoad: Promise<FriedFlaxiaModel> | null = null;

async function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const [glue, wasmUrl] = await Promise.all([
        import('../../vendor/friedflaxia/friedflaxia_wasm.js'),
        import('../../vendor/friedflaxia/friedflaxia_wasm_bg.wasm?url'),
      ]);
      await glue.default(wasmUrl.default);
    })();
  }
  return wasmReady;
}

export async function loadFriedFlaxiaModel(): Promise<FriedFlaxiaModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  modelLoad = (async () => {
    await initWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_EMBED_GEMMA);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as unknown as FriedFlaxiaModel;
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
  for (const text of texts) {
    const ids = loaded.encode(text, true);
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

export async function handleFriedFlaxiaEmbedGemma(
  payload: { texts: string[]; dimensions?: EmbedGemmaDimensions },
  onBatch?: () => void | Promise<void>,
): Promise<EmbedGemmaResult> {
  const startedAt = performance.now();
  const dimensions = payload.dimensions ?? (FRIEDFLAXIA_EMBED_GEMMA.dimensions as EmbedGemmaDimensions);
  const loaded = await loadFriedFlaxiaModel();
  const vectors = await embedTexts(loaded, payload.texts, dimensions, onBatch);
  return {
    vectors,
    model: FRIEDFLAXIA_EMBED_GEMMA.modelId,
    dimensions,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
