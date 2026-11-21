import type { VectorEmbedPayload, VectorEmbedResult } from '@flaxia/sdk';
import { fetchGuarded } from '../../executor/egress-guard';
import {
  EMBEDDING_GEMMA_AUDIO_SAMPLE_RATE,
  melSpectrogram,
  prepareImagePatches,
  prepareVideoFramePatches,
} from './embeddinggemma-preprocess';
import { decodeVideoFrames } from './video-decoder';
import {
  FRIEDFLAXIA_EMBED_GEMMA,
  FRIEDFLAXIA_EMBED_GEMMA_MMPROJ,
  downloadPinnedModel,
} from './model-registry';
import { initFriedFlaxiaWasm } from '../../vendor/friedflaxia/init';
import type { MultimodalWasmModel } from '../../vendor/friedflaxia/types';
import sharedManifest from '../../vendor/friedflaxia/model-manifest.json';

export type { MultimodalWasmModel } from '../../vendor/friedflaxia/types';

const {
  image: IMAGE_TOKEN,
  audio: AUDIO_TOKEN,
  video: VIDEO_TOKEN,
  boi: BOI_TOKEN,
  eoi: EOI_TOKEN,
  boa: BOA_TOKEN,
  eoa: EOA_TOKEN,
} = sharedManifest.specialTokens;
const EMBEDDING_WIDTH = sharedManifest.preprocess.embeddingWidth;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_SAMPLES = 30 * EMBEDDING_GEMMA_AUDIO_SAMPLE_RATE;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

let model: MultimodalWasmModel | null = null;
let modelLoad: Promise<MultimodalWasmModel> | null = null;

export async function loadFriedFlaxiaMultimodalModel(): Promise<MultimodalWasmModel> {
  if (model) return model;
  if (modelLoad) return modelLoad;
  modelLoad = (async () => {
    await initFriedFlaxiaWasm();
    const [textBytes, mmprojBytes] = await Promise.all([
      downloadPinnedModel(FRIEDFLAXIA_EMBED_GEMMA),
      downloadPinnedModel(FRIEDFLAXIA_EMBED_GEMMA_MMPROJ),
    ]);
    const { MultimodalModel } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded: MultimodalWasmModel = new MultimodalModel(textBytes, mmprojBytes);
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

interface MediaFeatures {
  rows: number;
  data: Float32Array;
}

async function fetchImageFeatures(
  loaded: MultimodalWasmModel,
  url: string,
): Promise<MediaFeatures> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['image/*', 'application/octet-stream'],
    maxBytes: MAX_IMAGE_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: image fetch failed (${res.status}): ${url}`);
  const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  const bitmap = await createImageBitmap(blob);
  try {
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width * bitmap.height > MAX_IMAGE_PIXELS
    ) {
      throw new Error(`vector-embed: image ${url} exceeds the ${MAX_IMAGE_PIXELS} pixel limit`);
    }
    const prepared = await prepareImagePatches(bitmap);
    const data = loaded.encode_image(
      prepared.patches,
      prepared.gridHeight,
      prepared.gridWidth,
    );
    return { rows: prepared.softTokens, data };
  } finally {
    bitmap.close();
  }
}

async function decodeAudio(bytes: Uint8Array, contentType: string): Promise<Float32Array> {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const AudioContextImpl =
    (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (AudioContextImpl) {
    const context = new AudioContextImpl(
      1,
      EMBEDDING_GEMMA_AUDIO_SAMPLE_RATE * 30,
      EMBEDDING_GEMMA_AUDIO_SAMPLE_RATE,
    );
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    const channel = decoded.getChannelData(0);
    return channel.subarray(0, Math.min(channel.length, MAX_AUDIO_SAMPLES));
  }
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error('vector-embed: cannot decode audio without WebAudio');
  }
  const view = new Int16Array(arrayBuffer);
  const length = Math.min(view.length, MAX_AUDIO_SAMPLES);
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) samples[index] = view[index] / 32768;
  return samples;
}

async function fetchAudioFeatures(
  loaded: MultimodalWasmModel,
  url: string,
): Promise<MediaFeatures> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['audio/*', 'application/octet-stream'],
    maxBytes: MAX_AUDIO_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: audio fetch failed (${res.status}): ${url}`);
  const samples = await decodeAudio(res.bytes, res.contentType || 'application/octet-stream');
  if (samples.length > MAX_AUDIO_SAMPLES) {
    throw new Error(`vector-embed: audio ${url} exceeds ${MAX_AUDIO_SAMPLES} samples`);
  }
  const { mel, frames, softTokens } = melSpectrogram(samples);
  if (softTokens < 1) throw new Error('vector-embed: audio clip produced no tokens');
  const all = loaded.encode_audio(mel, frames);
  return {
    rows: softTokens,
    data: all.slice(0, softTokens * EMBEDDING_WIDTH),
  };
}

interface VideoCount {
  tokens: number;
  frames: number;
}

interface MediaCounts {
  image: number[];
  audio: number[];
  video: VideoCount[];
}

/** Expand media placeholders into the soft-token blocks used by the model. */
export function buildMultimodalTokenIds(
  loaded: MultimodalWasmModel,
  text: string,
  counts: MediaCounts,
): Uint32Array {
  const bos = loaded.bos_token_id();
  const eos = loaded.eos_token_id();
  if (bos === undefined || eos === undefined) {
    throw new Error('vector-embed: tokenizer has no BOS/EOS tokens');
  }
  const ids: number[] = [bos];
  const indices = { image: 0, audio: 0, video: 0 };
  const pattern = /<\|(image|audio|video)\|>/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    ids.push(...loaded.encode(text.slice(cursor, start), false));
    const modality = match[1] as keyof MediaCounts;
    const count = counts[modality][indices[modality]];
    if (count === undefined) {
      throw new Error(`vector-embed: missing ${modality} media for placeholder`);
    }
    indices[modality] += 1;
    if (modality === 'audio') {
      ids.push(BOA_TOKEN);
      for (let index = 0; index < (count as number); index += 1) ids.push(AUDIO_TOKEN);
      ids.push(EOA_TOKEN);
    } else if (modality === 'video') {
      const video = count as VideoCount;
      for (let frame = 0; frame < video.frames; frame += 1) {
        ids.push(BOI_TOKEN);
        for (let index = 0; index < video.tokens; index += 1) ids.push(VIDEO_TOKEN);
        ids.push(EOI_TOKEN);
      }
    } else {
      ids.push(BOI_TOKEN);
      for (let index = 0; index < (count as number); index += 1) ids.push(IMAGE_TOKEN);
      ids.push(EOI_TOKEN);
    }
    cursor = start + match[0].length;
  }
  ids.push(...loaded.encode(text.slice(cursor), false));
  ids.push(eos);
  for (const modality of ['image', 'audio', 'video'] as const) {
    if (indices[modality] !== counts[modality].length) {
      throw new Error(`vector-embed: ${modality} media count does not match placeholders`);
    }
  }
  return Uint32Array.from(ids);
}

export interface FriedFlaxiaVectorEmbedResult {
  vector: number[];
  durationMs: number;
}

export async function handleFriedFlaxiaVectorEmbed(
  payload: VectorEmbedPayload,
  text: string,
  imageUrls: string[],
  audioUrl: string | undefined,
  videoUrl: string | undefined,
): Promise<FriedFlaxiaVectorEmbedResult> {
  const startedAt = performance.now();
  const loaded = await loadFriedFlaxiaMultimodalModel();

  const images: MediaFeatures[] = [];
  for (const url of imageUrls) images.push(await fetchImageFeatures(loaded, url));
  const audio = audioUrl ? await fetchAudioFeatures(loaded, audioUrl) : null;
  const videos: MediaFeatures[] = [];
  const videoCounts: VideoCount[] = [];
  if (videoUrl) {
    const videoFeatures = await fetchVideoFeatures(loaded, videoUrl);
    videos.push(...videoFeatures.frames);
    videoCounts.push({ tokens: videoFeatures.rows, frames: videoFeatures.frames.length });
  }

  const counts = {
    image: images.map((image) => image.rows),
    audio: audio ? [audio.rows] : [],
    video: videoCounts,
  };
  const ids = buildMultimodalTokenIds(loaded, text, counts);
  const imageData = concatFeatures(images);
  const videoData = concatFeatures(videos);
  const audioData = audio?.data ?? new Float32Array(0);
  const embedding = loaded.embed(ids, imageData, videoData, audioData);
  // Matryoshka truncation to the public dimension and L2 re-normalization.
  const vector = Array.from(embedding.slice(0, 768));
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  return { vector, durationMs: Math.round(performance.now() - startedAt) };
}

async function fetchVideoFeatures(
  loaded: MultimodalWasmModel,
  url: string,
): Promise<{ frames: MediaFeatures[]; rows: number }> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['video/*', 'application/octet-stream'],
    maxBytes: MAX_VIDEO_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`vector-embed: video fetch failed (${res.status}): ${url}`);
  const decoded = await decodeVideoFrames(res.bytes);
  const frames: MediaFeatures[] = [];
  let rows = 0;
  try {
    for (const bitmap of decoded.frames) {
      const prepared = await prepareVideoFramePatches(bitmap);
      rows = prepared.softTokens;
      frames.push({
        rows: prepared.softTokens,
        data: loaded.encode_image(prepared.patches, prepared.gridHeight, prepared.gridWidth),
      });
      bitmap.close();
    }
  } catch (error) {
    for (const bitmap of decoded.frames) {
      try {
        bitmap.close();
      } catch {}
    }
    throw error;
  }
  if (frames.length === 0 || rows === 0) {
    throw new Error('vector-embed: video produced no soft tokens');
  }
  return { frames, rows };
}

function concatFeatures(features: MediaFeatures[]): Float32Array {
  const total = features.reduce((sum, item) => sum + item.data.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const item of features) {
    out.set(item.data, offset);
    offset += item.data.length;
  }
  return out;
}
