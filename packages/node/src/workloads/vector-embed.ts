import type { VectorEmbedPayload, VectorEmbedResult } from '@flaxia/sdk';

/**
 * Multimodal vector-embed workload (EmbeddingGemma 2).
 *
 * Produces one unified 768-dim vector per post from interleaved text + image
 * (+ audio / video frames). The SDK payload carries media as publicly
 * fetchable URLs (same contract as NSFW `imageUrl`); the node fetches bytes
 * itself so hosts never ship base64 through the orchestrator.
 *
 * Placeholder convention (sentence-transformers): `<|image|>`, `<|video|>`,
 * `<|audio|>` markers in `text` are filled in order from the URL arrays.
 */

const EMBEDDING_MODEL = 'google/embeddinggemma-2';
const EMBEDDING_DIMENSIONS = 768;

let embeddingPipeline: any = null;
let embeddingLoadPromise: Promise<any> | null = null;

export const releaseCache = (): void => {
  embeddingPipeline = null;
  embeddingLoadPromise = null;
};

async function loadEmbeddingPipeline(): Promise<any> {
  if (embeddingPipeline) return embeddingPipeline;
  if (embeddingLoadPromise) return embeddingLoadPromise;

  const loadStartedAt = performance.now();
  embeddingLoadPromise = (async () => {
    console.log(`[flaxia-node] vector-embed: loading pipeline model=${EMBEDDING_MODEL} device=wasm`);
    const { pipeline, env } = await import('@huggingface/transformers');
    // Force single-threaded wasm (see ai-inference.ts for rationale): avoids
    // spawning a worker per CPU core and OOMing low-memory mobile devices.
    if (env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }
    const pipe = await pipeline('feature-extraction', EMBEDDING_MODEL, { device: 'wasm' } as any);
    embeddingPipeline = pipe;
    console.log(
      `[flaxia-node] vector-embed: pipeline ready loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    return pipe;
  })().catch((err) => {
    embeddingLoadPromise = null;
    console.error(
      `[flaxia-node] vector-embed: pipeline load FAILED error=${err instanceof Error ? err.message : String(err)}`,
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

export async function handleVectorEmbed(payload: VectorEmbedPayload): Promise<VectorEmbedResult> {
  const startTime = performance.now();
  const pipe = await loadEmbeddingPipeline();
  const { text, imageUrls, audioUrl, videoUrl } = assertMultimodalPayload(payload);

  const modelStartedAt = performance.now();
  const multimodal =
    imageUrls.length > 0 || audioUrl || videoUrl;

  if (!multimodal) {
    // Backward-compatible text-only path.
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(result.data) as number[];
    const durationMs = Math.round(performance.now() - startTime);
    console.log(
      `[flaxia-node] vector-embed: done dims=${vector.length} modelMs=${Math.round(performance.now() - modelStartedAt)} totalMs=${durationMs} textLen=${text.length}`,
    );
    return { vector, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, durationMs };
  }

  // Fetch media bytes; encode interleaved text + media in one call.
  const { loadImage } = (await import('@huggingface/transformers')) as any;
  const input: Record<string, unknown> = {};
  const interleaved = buildInterleavedText(
    text || ' ',
    { images: imageUrls.length, videos: videoUrl ? 1 : 0, audio: audioUrl ? 1 : 0 },
  );
  input.text = interleaved;

  if (imageUrls.length > 0) {
    const images: unknown[] = [];
    for (const url of imageUrls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`vector-embed: image fetch failed (${res.status}): ${url}`);
      images.push(await loadImage(URL.createObjectURL(await res.blob())));
    }
    input.image = images.length === 1 ? images[0] : images;
  }
  if (audioUrl) {
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`vector-embed: audio fetch failed (${res.status}): ${audioUrl}`);
    const arrayBuffer = await res.arrayBuffer();
    input.audio = new Int16Array(arrayBuffer.slice(0));
  }
  if (videoUrl) {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`vector-embed: video fetch failed (${res.status}): ${videoUrl}`);
    // Video bytes are consumed as sampled frames by the processor (1fps);
    // pass the blob URL so transformers.js can decode frames.
    input.video = URL.createObjectURL(await res.blob());
  }

  const result = await pipe(input, { pooling: 'mean', normalize: true });
  const vector = Array.from(result.data) as number[];
  const durationMs = Math.round(performance.now() - startTime);
  console.log(
    `[flaxia-node] vector-embed: done dims=${vector.length} modelMs=${Math.round(performance.now() - modelStartedAt)} totalMs=${durationMs} textLen=${text.length} images=${imageUrls.length} audio=${audioUrl ? 1 : 0} video=${videoUrl ? 1 : 0}`,
  );
  return { vector, model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, durationMs };
}
