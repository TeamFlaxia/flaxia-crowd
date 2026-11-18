/** Image/audio preprocessing for the d1-omni SigLIP2 + FastConformer towers. */

import { fetchGuarded } from '../../executor/egress-guard';

const TILE_SIZE = 512;
const PATCH_SIZE = 16;
const PATCH_DIM = PATCH_SIZE * PATCH_SIZE * 3;
const AUDIO_SAMPLE_RATE = 16_000;

export const D1_IMAGE_TOKENS = 256;

export const MAX_D1_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_D1_IMAGE_PIXELS = 16 * 1024 * 1024;
export const MAX_D1_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_D1_AUDIO_SAMPLES = 30 * AUDIO_SAMPLE_RATE;
const FETCH_TIMEOUT_MS = 30_000;

export interface D1Image {
  patches: Float32Array;
  grid: number;
}

/** Resize to the 512x512 tile and emit `(y, x, channel)` patches in [-1, 1]. */
export async function prepareD1Image(bitmap: ImageBitmap): Promise<D1Image> {
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('decision: no 2d canvas context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  const rgba = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const patches = new Float32Array(1024 * PATCH_DIM);
  let out = 0;
  for (let py = 0; py < TILE_SIZE / PATCH_SIZE; py += 1) {
    for (let px = 0; px < TILE_SIZE / PATCH_SIZE; px += 1) {
      for (let dy = 0; dy < PATCH_SIZE; dy += 1) {
        const row = ((py * PATCH_SIZE + dy) * TILE_SIZE + px * PATCH_SIZE) * 4;
        for (let dx = 0; dx < PATCH_SIZE; dx += 1) {
          const source = row + dx * 4;
          for (let c = 0; c < 3; c += 1) {
            patches[out++] = (rgba[source + c] / 255 - 0.5) / 0.5;
          }
        }
      }
    }
  }
  return { patches, grid: TILE_SIZE / PATCH_SIZE };
}

export async function fetchD1Image(
  url: string,
): Promise<{ image: D1Image; rows: number }> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['image/*', 'application/octet-stream'],
    maxBytes: MAX_D1_IMAGE_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`decision: image fetch failed (${res.status}): ${url}`);
  const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
  const bitmap = await createImageBitmap(blob);
  try {
    if (
      !Number.isSafeInteger(bitmap.width) ||
      !Number.isSafeInteger(bitmap.height) ||
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width * bitmap.height > MAX_D1_IMAGE_PIXELS
    ) {
      throw new Error(`decision: image ${url} exceeds the ${MAX_D1_IMAGE_PIXELS} pixel limit`);
    }
    return { image: await prepareD1Image(bitmap), rows: D1_IMAGE_TOKENS };
  } finally {
    bitmap.close();
  }
}

export async function fetchD1Audio(url: string): Promise<Float32Array> {
  const res = await fetchGuarded({
    url,
    allowContentTypes: ['audio/*', 'application/octet-stream'],
    maxBytes: MAX_D1_AUDIO_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`decision: audio fetch failed (${res.status}): ${url}`);
  const arrayBuffer = res.bytes.buffer.slice(
    res.bytes.byteOffset,
    res.bytes.byteOffset + res.bytes.byteLength,
  ) as ArrayBuffer;
  const AudioContextImpl =
    (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (AudioContextImpl) {
    const context = new AudioContextImpl(1, AUDIO_SAMPLE_RATE * 30, AUDIO_SAMPLE_RATE);
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    const channel = decoded.getChannelData(0);
    return channel.subarray(0, Math.min(channel.length, MAX_D1_AUDIO_SAMPLES));
  }
  const view = new Int16Array(arrayBuffer);
  const samples = new Float32Array(Math.min(view.length, MAX_D1_AUDIO_SAMPLES));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view[index] / 32768;
  return samples;
}
