/**
 * Preprocessing for the FriedFlaxia EmbeddingGemma 2 multimodal runtime.
 *
 * Images are decoded with `createImageBitmap`, resized with the canvas API
 * (matching the browser path of Transformers.js `RawImage.resize`), then
 * patchified into the `(y, x, channel)` layout the vision encoder expects.
 *
 * Audio is resampled to 16 kHz by the caller and converted to the Gemma 4
 * log-mel layout here: semicausal framing, 512-point FFT, 128 HTK mel bands,
 * `log(mel + 0.001)`.
 */

const PATCH_SIZE = 16;
const POOLING = 3;
const DEFAULT_MAX_SOFT_TOKENS = 280;
const VIDEO_MAX_SOFT_TOKENS = 140;
const MEL_BINS = 128;
const FRAME_LENGTH = 320;
const HOP_LENGTH = 160;
const FFT_LENGTH = 512;
const SAMPLE_RATE = 16_000;
const MEL_FLOOR = 0.001;

export const EMBEDDING_GEMMA_AUDIO_SAMPLE_RATE = SAMPLE_RATE;

export interface PreparedImage {
  patches: Float32Array;
  gridHeight: number;
  gridWidth: number;
  softTokens: number;
}

export function aspectRatioPreservingSize(
  height: number,
  width: number,
  maxSoftTokens = DEFAULT_MAX_SOFT_TOKENS,
): [number, number] {
  const maxPatches = maxSoftTokens * POOLING * POOLING;
  const targetPx = maxPatches * PATCH_SIZE ** 2;
  const factor = Math.sqrt(targetPx / (height * width));
  const side = POOLING * PATCH_SIZE;
  let targetHeight = Math.floor((factor * height) / side) * side;
  let targetWidth = Math.floor((factor * width) / side) * side;
  if (targetHeight === 0 && targetWidth === 0) {
    throw new Error('embeddinggemma: image is too small to resize');
  }
  const maxSide = Math.floor(maxPatches / POOLING ** 2) * side;
  if (targetHeight === 0) {
    targetHeight = side;
    targetWidth = Math.min(Math.floor(width / height) * side, maxSide);
  } else if (targetWidth === 0) {
    targetWidth = side;
    targetHeight = Math.min(Math.floor(height / width) * side, maxSide);
  }
  return [targetHeight, targetWidth];
}

export function patchifyRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): PreparedImage {
  if (width % PATCH_SIZE !== 0 || height % PATCH_SIZE !== 0) {
    throw new Error('embeddinggemma: patch grid is not aligned');
  }
  const gridHeight = height / PATCH_SIZE;
  const gridWidth = width / PATCH_SIZE;
  const patches = new Float32Array(gridHeight * gridWidth * PATCH_SIZE * PATCH_SIZE * 3);
  let out = 0;
  for (let py = 0; py < gridHeight; py += 1) {
    for (let px = 0; px < gridWidth; px += 1) {
      for (let dy = 0; dy < PATCH_SIZE; dy += 1) {
        const row = ((py * PATCH_SIZE + dy) * width + px * PATCH_SIZE) * 4;
        for (let dx = 0; dx < PATCH_SIZE; dx += 1) {
          const source = row + dx * 4;
          patches[out++] = rgba[source] / 255;
          patches[out++] = rgba[source + 1] / 255;
          patches[out++] = rgba[source + 2] / 255;
        }
      }
    }
  }
  return {
    patches,
    gridHeight,
    gridWidth,
    softTokens: Math.floor((gridHeight * gridWidth) / POOLING ** 2),
  };
}

export async function prepareImagePatches(
  bitmap: ImageBitmap,
  maxSoftTokens = DEFAULT_MAX_SOFT_TOKENS,
): Promise<PreparedImage> {
  const [height, width] = aspectRatioPreservingSize(bitmap.height, bitmap.width, maxSoftTokens);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('embeddinggemma: no 2d canvas context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  return patchifyRgba(data, width, height);
}

/** Video frames use the smaller per-frame soft-token budget. */
export async function prepareVideoFramePatches(bitmap: ImageBitmap): Promise<PreparedImage> {
  return prepareImagePatches(bitmap, VIDEO_MAX_SOFT_TOKENS);
}

/** Periodic Hann window of `FRAME_LENGTH` samples. */
function hannWindow(): Float64Array {
  const length = FRAME_LENGTH + 1;
  const window = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
  }
  return window.subarray(0, FRAME_LENGTH);
}

function hertzToMel(frequency: number): number {
  return 2595 * Math.log10(1 + frequency / 700);
}

function melToHertz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

let melFilters: Float64Array | null = null;

function getMelFilters(): Float64Array {
  if (melFilters) return melFilters;
  const bins = FFT_LENGTH / 2 + 1;
  const melMin = hertzToMel(0);
  const melMax = hertzToMel(SAMPLE_RATE / 2);
  const points = new Float64Array(MEL_BINS + 2);
  const step = (melMax - melMin) / (MEL_BINS + 1);
  for (let index = 0; index < points.length; index += 1) {
    points[index] = melToHertz(melMin + step * index);
  }
  const fftFreqs = new Float64Array(bins);
  for (let index = 0; index < bins; index += 1) {
    fftFreqs[index] = (index * SAMPLE_RATE) / 2 / (bins - 1);
  }
  const filters = new Float64Array(MEL_BINS * bins);
  for (let bin = 0; bin < bins; bin += 1) {
    for (let filter = 0; filter < MEL_BINS; filter += 1) {
      const down = (fftFreqs[bin] - points[filter]) / (points[filter + 1] - points[filter]);
      const up =
        (points[filter + 2] - fftFreqs[bin]) / (points[filter + 2] - points[filter + 1]);
      filters[filter * bins + bin] = Math.max(0, Math.min(down, up));
    }
  }
  melFilters = filters;
  return filters;
}

/** Iterative radix-2 FFT; `real`/`imag` length is `FFT_LENGTH`. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let curReal = 1;
      let curImag = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * curReal - imag[odd] * curImag;
        const oddImag = real[odd] * curImag + imag[odd] * curReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

export interface MelResult {
  mel: Float32Array;
  frames: number;
  softTokens: number;
}

/**
 * Compute the Gemma 4 log-mel features for 16 kHz mono audio.
 *
 * The returned `frames` includes trailing padding frames, exactly like the
 * reference feature extractor. `softTokens` is the number of valid tokens
 * after the encoder's two stride-2 convolutions (one per 4 mel frames).
 */
export function melSpectrogram(samples: Float32Array): MelResult {
  const padded = new Float64Array(samples.length + FRAME_LENGTH / 2);
  padded.set(samples, FRAME_LENGTH / 2);
  // Python: unfold(size=frame_length + 1, step=hop_length)
  const frames = Math.floor((samples.length + FRAME_LENGTH / 2 - (FRAME_LENGTH + 1)) / HOP_LENGTH) + 1;
  if (frames <= 0) throw new Error('embeddinggemma: audio clip is too short');

  const window = hannWindow();
  const filters = getMelFilters();
  const bins = FFT_LENGTH / 2 + 1;
  const mel = new Float32Array(frames * MEL_BINS);
  const real = new Float64Array(FFT_LENGTH);
  const imag = new Float64Array(FFT_LENGTH);
  const power = new Float64Array(bins);

  for (let frame = 0; frame < frames; frame += 1) {
    real.fill(0);
    imag.fill(0);
    const offset = frame * HOP_LENGTH;
    const available = Math.min(FRAME_LENGTH, padded.length - offset);
    for (let index = 0; index < available; index += 1) {
      real[index] = padded[offset + index] * window[index];
    }
    fft(real, imag);
    for (let bin = 0; bin < bins; bin += 1) {
      power[bin] = Math.sqrt(real[bin] * real[bin] + imag[bin] * imag[bin]);
    }
    for (let filter = 0; filter < MEL_BINS; filter += 1) {
      let sum = 0;
      const base = filter * bins;
      for (let bin = 0; bin < bins; bin += 1) {
        sum += filters[base + bin] * power[bin];
      }
      mel[frame * MEL_BINS + filter] = Math.log(sum + MEL_FLOOR);
    }
  }

  // A frame is valid only when all of its `frame_length + 1` samples are real
  // audio. Invalid frames are zeroed, and only valid frames produce output
  // tokens after the encoder's two stride-2 convolutions.
  const padLeft = FRAME_LENGTH / 2;
  const sampleMask = new Uint8Array(samples.length + padLeft + 128);
  sampleMask.fill(1, padLeft, padLeft + samples.length);
  let softTokens = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const valid = sampleMask[frame * HOP_LENGTH + FRAME_LENGTH] === 1;
    if (!valid) mel.fill(0, frame * MEL_BINS, (frame + 1) * MEL_BINS);
    if (frame % 4 === 0 && valid) softTokens += 1;
  }
  return { mel, frames, softTokens };
}
