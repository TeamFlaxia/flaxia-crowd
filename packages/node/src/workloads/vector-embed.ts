import type { VectorEmbedPayload, VectorEmbedResult } from '@flaxia/sdk';
import { resolveAiModel } from './ai-model-registry';
import { fetchGuarded } from '../executor/egress-guard';

/**
 * Multimodal vector-embed workload (EmbeddingGemma 2).
 *
 * Produces one unified 768-dim vector per post from interleaved text + image
 * (+ audio / video frames). The SDK payload carries media as publicly
 * fetchable URLs (same contract as NSFW `imageUrl`); the node fetches bytes
 * itself (via the egress guard) so hosts never ship base64 through the
 * orchestrator.
 *
 * Placeholder convention (sentence-transformers): `<|image|>`, `<|video|>`,
 * `<|audio|>` markers in `text` are filled in order from the URL arrays.
 *
 * Loading uses AutoProcessor/AutoModel (not the `feature-extraction` pipeline):
 * Transformers.js 4.3+ documents multimodal EmbeddingGemma2 as
 * `processor(text, images, audio, videos)` -> `model(processed).sentence_embedding`.
 * The pipeline is text-only.
 */

const EMBEDDING_MODEL = 'onnx-community/embeddinggemma-2-ONNX';
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_AUDIO_SAMPLE_RATE = 16_000;

/** Per-file media caps (compressed bytes). */
export const MAX_VECTOR_EMBED_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VECTOR_EMBED_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_VECTOR_EMBED_VIDEO_BYTES = 50 * 1024 * 1024;
/** Media fetch timeout. */
const VECTOR_EMBED_FETCH_TIMEOUT_MS = 30_000;
/** Text length cap (mirrors ai-inference MAX_AI_INPUT_CHARS). */
const MAX_VECTOR_EMBED_TEXT_CHARS = 100_000;

interface LoadedEmbeddingModel {
  processor: any;
  model: any;
}

let embeddingModel: LoadedEmbeddingModel | null = null;
let embeddingLoadPromise: Promise<LoadedEmbeddingModel> | null = null;

export const releaseCache = (): void => {
  embeddingModel = null;
  embeddingLoadPromise = null;
};

let downloadGuardInstalled = false;

/**
 * Keep model downloads on Hugging Face and bound a single file by the
 * registry's `maxBytes`. The ai-inference fetch guard is installed only when
 * that workload is used, so vector-embed needs its own check when it is the
 * first model task (same pattern as embed-gemma).
 */
function installDownloadGuard(env: any, maxBytes: number): void {
  if (downloadGuardInstalled) return;
  downloadGuardInstalled = true;
  const inner = typeof env.fetch === 'function' ? env.fetch.bind(env) : globalThis.fetch.bind(globalThis);
  env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!/(^|\.)huggingface\.co$/.test(url.hostname) && !/(^|\.)hf\.co$/.test(url.hostname)) {
      throw new Error(`vector-embed: model download blocked from ${url.hostname}`);
    }
    const response = await inner(url, init);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`vector-embed: model file too large (${declared} bytes > ${maxBytes})`);
    }
    return response;
  };
}

async function loadEmbeddingModel(): Promise<LoadedEmbeddingModel> {
  if (embeddingModel) return embeddingModel;
  if (embeddingLoadPromise) return embeddingLoadPromise;

  const loadStartedAt = performance.now();
  embeddingLoadPromise = (async () => {
    const definition = resolveAiModel(EMBEDDING_MODEL);
    console.log(`[flaxia-node] vector-embed: loading model=${definition.repo} revision=${definition.revision} device=wasm dtype=fp16`);
    const { AutoModel, AutoProcessor, env } = await import('@huggingface/transformers');
    if (env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }
    installDownloadGuard(env, definition.maxBytes);
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(definition.repo, { revision: definition.revision }),
      AutoModel.from_pretrained(definition.repo, {
        device: 'wasm',
        dtype: 'fp16',
        revision: definition.revision,
      } as any),
    ]);
    const loaded: LoadedEmbeddingModel = { processor, model };
    embeddingModel = loaded;
    console.log(
      `[flaxia-node] vector-embed: model ready loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    return loaded;
  })().catch((err) => {
    embeddingLoadPromise = null;
    console.error(
      `[flaxia-node] vector-embed: model load FAILED error=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  });
  return embeddingLoadPromise;
}

function assertMultimodalPayload(payload: VectorEmbedPayload): {
  text: string;
  imageUrls: string[];
  audioUrl?: string;
  videoUrl?: string;
} {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text.length > MAX_VECTOR_EMBED_TEXT_CHARS) {
    throw new Error(`vector-embed: text exceeds ${MAX_VECTOR_EMBED_TEXT_CHARS} characters`);
  }
  const imageUrls = payload.imageUrls ?? [];
  if (!Array.isArray(imageUrls) || imageUrls.length > 29) {
    throw new Error('vector-embed: imageUrls must hold 0..29 URLs');
  }
  for (const url of imageUrls) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('vector-embed: imageUrls must be https:// URLs');
    }
  }
  const audioUrl = payload.audioUrl;
  if (audioUrl !== undefined && (typeof audioUrl !== 'string' || !audioUrl.startsWith('https://'))) {
    throw new Error('vector-embed: audioUrl must be an https:// URL');
  }
  const videoUrl = payload.videoUrl;
  if (videoUrl !== undefined && (typeof videoUrl !== 'string' || !videoUrl.startsWith('https://'))) {
    throw new Error('vector-embed: videoUrl must be an https:// URL');
  }
  if (!text && imageUrls.length === 0 && !audioUrl && !videoUrl) {
    throw new Error('vector-embed: need at least text or one media URL');
  }
  return { text, imageUrls: [...imageUrls], audioUrl, videoUrl };
}

/** Append `<|image|>` / `<|video|>` / `<|audio|>` placeholders for any media whose placeholder is missing. */
export function buildInterleavedText(
  text: string,
  counts: { images: number; videos: number; audio: number },
): string {
  let out = text;
  const placeholders = (marker: string): number => out.split(marker).length - 1;
  if (counts.images > placeholders('<|image|>')) out += ' <|image|>'.repeat(counts.images - placeholders('<|image|>'));
  if (counts.videos > placeholders('<|video|>')) out += ' <|video|>'.repeat(counts.videos - placeholders('<|video|>'));
  if (counts.audio > placeholders('<|audio|>')) out += ' <|audio|>'.repeat(counts.audio - placeholders('<|audio|>'));
  return out;
}

async function fetchImageForEmbed(url: string): Promise<unknown> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['image/*', 'application/octet-stream'],
    maxBytes: MAX_VECTOR_EMBED_IMAGE_BYTES,
    timeoutMs: VECTOR_EMBED_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: image fetch failed (${res.status}): ${url}`);
  const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const { loadImage } = (await import('@huggingface/transformers')) as any;
    return await loadImage(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function fetchAudioForEmbed(url: string): Promise<unknown> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['audio/*', 'application/octet-stream'],
    maxBytes: MAX_VECTOR_EMBED_AUDIO_BYTES,
    timeoutMs: VECTOR_EMBED_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: audio fetch failed (${res.status}): ${url}`);
  const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const { loadAudio } = (await import('@huggingface/transformers')) as any;
    return await loadAudio(blobUrl, EMBEDDING_AUDIO_SAMPLE_RATE);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function fetchVideoForEmbed(url: string): Promise<unknown> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['video/*', 'application/octet-stream'],
    maxBytes: MAX_VECTOR_EMBED_VIDEO_BYTES,
    timeoutMs: VECTOR_EMBED_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: video fetch failed (${res.status}): ${url}`);
  const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const { loadVideo } = (await import('@huggingface/transformers')) as any;
    return await loadVideo(blobUrl, { fps: 1 });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function handleVectorEmbed(payload: VectorEmbedPayload): Promise<VectorEmbedResult> {
  const startTime = performance.now();
  const { text, imageUrls, audioUrl, videoUrl } = assertMultimodalPayload(payload);
  const loaded = await loadEmbeddingModel();

  const modelStartedAt = performance.now();
  const multimodal = imageUrls.length > 0 || audioUrl || videoUrl;

  if (!multimodal) {
    const processed = await loaded.processor(text);
    const output = await loaded.model(processed);
    const embedding = output?.sentence_embedding;
    if (!embedding || !embedding.data) {
      throw new Error('vector-embed: model did not return sentence_embedding');
    }
    const vector = Array.from(embedding.data) as number[];
    const durationMs = Math.round(performance.now() - startTime);
    console.log(
      `[flaxia-node] vector-embed: done dims=${vector.length} modelMs=${Math.round(performance.now() - modelStartedAt)} totalMs=${durationMs} textLen=${text.length}`,
    );
    return { vector, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, durationMs };
  }

  // Multimodal: fetch media via the egress guard, decode with Transformers.js
  // loaders, then processor(text, images, audio, video) as documented.
  const images: unknown[] = [];
  for (const url of imageUrls) {
    images.push(await fetchImageForEmbed(url));
  }
  const audio = audioUrl ? await fetchAudioForEmbed(audioUrl) : null;
  const video = videoUrl ? await fetchVideoForEmbed(videoUrl) : null;

  const interleaved = buildInterleavedText(
    text || ' ',
    { images: images.length, videos: video ? 1 : 0, audio: audio ? 1 : 0 },
  );
  const imageInput = images.length === 0 ? null : images.length === 1 ? images[0] : images;
  const processed = await loaded.processor(interleaved, imageInput, audio, video);
  const output = await loaded.model(processed);
  const embedding = output?.sentence_embedding;
  if (!embedding || !embedding.data) {
    throw new Error('vector-embed: model did not return sentence_embedding');
  }
  const vector = Array.from(embedding.data) as number[];
  const durationMs = Math.round(performance.now() - startTime);
  console.log(
    `[flaxia-node] vector-embed: done dims=${vector.length} modelMs=${Math.round(performance.now() - modelStartedAt)} totalMs=${durationMs} textLen=${text.length} images=${imageUrls.length} audio=${audioUrl ? 1 : 0} video=${videoUrl ? 1 : 0}`,
  );
  return { vector, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, durationMs };
}
