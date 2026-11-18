import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aspectRatioPreservingSize,
  melSpectrogram,
  patchifyRgba,
} from '../friedflaxia/embeddinggemma-preprocess';

const fixtures = join(__dirname, 'fixtures');

function floats(path: string): Float32Array {
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

describe('EmbeddingGemma preprocessing', () => {
  it('computes aspect-ratio-preserving sizes aligned to 48 pixels', () => {
    expect(aspectRatioPreservingSize(1000, 500)).toEqual([1104, 528]);
    expect(aspectRatioPreservingSize(500, 1000)).toEqual([528, 1104]);
  });

  it('patchifies RGBA in (y, x, channel) order', () => {
    const width = 48;
    const height = 48;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      rgba[index * 4] = index % 256;
      rgba[index * 4 + 1] = 1;
      rgba[index * 4 + 2] = 2;
    }
    const prepared = patchifyRgba(rgba, width, height);
    expect(prepared.gridHeight).toBe(3);
    expect(prepared.gridWidth).toBe(3);
    expect(prepared.softTokens).toBe(1);
    expect(prepared.patches).toHaveLength(3 * 3 * 16 * 16 * 3);
    expect(prepared.patches[0]).toBeCloseTo(0 / 255);
    expect(prepared.patches[1]).toBeCloseTo(1 / 255);
    expect(prepared.patches[2]).toBeCloseTo(2 / 255);
    expect(prepared.patches[3]).toBeCloseTo(1 / 255);
  });

  it('matches the Transformers.js Gemma 4 log-mel features', () => {
    const samples = floats(join(fixtures, 'mel-samples.bin'));
    const expected = floats(join(fixtures, 'mel-golden.bin'));
    const actual = melSpectrogram(samples);
    expect(actual.frames).toBe(99);
    expect(actual.softTokens).toBe(25);
    expect(actual.mel).toHaveLength(expected.length);
    let maxAbs = 0;
    let total = 0;
    for (let index = 0; index < expected.length; index += 1) {
      const diff = Math.abs(actual.mel[index] - expected[index]);
      maxAbs = Math.max(maxAbs, diff);
      total += diff;
    }
    console.log('mel max_abs=' + maxAbs + ' mean_abs=' + total / expected.length + ' ours=' + Array.from(actual.mel.slice(0, 5)) + ' expected=' + Array.from(expected.slice(0, 5)));
    expect(maxAbs).toBeLessThan(2e-4);
  });
});
