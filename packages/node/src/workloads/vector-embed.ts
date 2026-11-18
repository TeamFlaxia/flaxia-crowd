import type { VectorEmbedPayload, VectorEmbedResult } from '@flaxia/sdk';
import { handleFriedFlaxiaEmbedGemma, releaseCache as releaseEmbedGemma } from './friedflaxia/embed-gemma';
import {
  handleFriedFlaxiaVectorEmbed,
  releaseCache as releaseMultimodal,
} from './friedflaxia/multimodal-embed';

/**
 * Multimodal vector-embed workload (EmbeddingGemma 2) on FriedFlaxia.
 *
 * Produces one unified 768-dim vector per post from interleaved text + image
 * (+ audio). The SDK payload carries media as publicly fetchable URLs; the
 * node fetches bytes itself through the egress guard.
 */

const EMBEDDING_MODEL = 'onnx-community/embeddinggemma-2-ONNX';
const EMBEDDING_DIMENSIONS = 768;

/** Per-file media caps (compressed bytes). */
export const MAX_VECTOR_EMBED_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VECTOR_EMBED_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_VECTOR_EMBED_VIDEO_BYTES = 50 * 1024 * 1024;
/** Bound decoded pixels per image (RGBA ~4 bytes/pixel). */
export const MAX_VECTOR_EMBED_IMAGE_PIXELS = 16 * 1024 * 1024;
/** Bound decoded audio samples (30 s at 16 kHz). */
export const MAX_VECTOR_EMBED_AUDIO_SAMPLES = 30 * 16_000;
/** Maximum frames sampled from a video, so the decoder never materializes a long clip. */
export const MAX_VECTOR_EMBED_VIDEO_FRAMES = 16;
/** Text length cap (mirrors ai-inference MAX_AI_INPUT_CHARS). */
const MAX_VECTOR_EMBED_TEXT_CHARS = 100_000;

export const releaseCache = (): void => {
  releaseEmbedGemma();
  releaseMultimodal();
};

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

export async function handleVectorEmbed(payload: VectorEmbedPayload): Promise<VectorEmbedResult> {
  const startTime = performance.now();
  const { text, imageUrls, audioUrl, videoUrl } = assertMultimodalPayload(payload);
  const multimodal = imageUrls.length > 0 || Boolean(audioUrl) || Boolean(videoUrl);

  if (!multimodal) {
    const result = await handleFriedFlaxiaEmbedGemma({
      texts: [text],
      dimensions: EMBEDDING_DIMENSIONS,
    });
    return {
      vector: result.vectors[0],
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  const interleaved = buildInterleavedText(text || ' ', {
    images: imageUrls.length,
    videos: videoUrl ? 1 : 0,
    audio: audioUrl ? 1 : 0,
  });
  const result = await handleFriedFlaxiaVectorEmbed(payload, interleaved, imageUrls, audioUrl, videoUrl);
  return {
    vector: result.vector,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    durationMs: Math.round(performance.now() - startTime),
  };
}
