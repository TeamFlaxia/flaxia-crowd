import { describe, expect, it } from 'vitest';
import { detectionsFromFlat } from '../friedflaxia/nudenet';

describe('friedflaxia NudeNet', () => {
  it('converts flat rows, labels and scales boxes to input pixels', () => {
    const flat = new Float32Array([
      10, 20, 30, 40, 0.9, 2,
      1, 2, 3, 4, 0.25, 0,
    ]);
    const detections = detectionsFromFlat(flat, 2);
    expect(detections).toHaveLength(2);
    expect(detections[0].label).toBe('BUTTOCKS_EXPOSED');
    expect(detections[0].score).toBeCloseTo(0.9, 6);
    expect(detections[0].box).toEqual([20, 40, 60, 80]);
    expect(detections[1].label).toBe('FEMALE_GENITALIA_COVERED');
    expect(detections[1].score).toBeCloseTo(0.25, 6);
    expect(detections[1].box).toEqual([2, 4, 6, 8]);
  });

  it('ignores incomplete rows and unknown label indices', () => {
    expect(detectionsFromFlat([1, 2, 3], 1)).toEqual([]);
    expect(detectionsFromFlat([1, 2, 3, 4, 0.5, 99], 1)).toEqual([]);
  });
});
