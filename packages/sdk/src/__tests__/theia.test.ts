import { describe, expect, it } from 'vitest';
import {
  MAX_THEIA_CANVAS_CHARS,
  MAX_THEIA_DELTA_OPS,
  MAX_THEIA_DELTA_TEXT_CHARS,
  MAX_THEIA_SPANS,
  isTheiaCanvas,
  isTheiaDelta,
  isTheiaPhase,
} from '../theia';
import type { TheiaCanvas, TheiaDelta } from '../types';

function canvas(overrides: Partial<TheiaCanvas> = {}): TheiaCanvas {
  return {
    version: 0,
    text: '____ and ____',
    spans: [
      { id: 'a', start: 0, end: 4, open: true },
      { id: 'b', start: 9, end: 13, open: true },
    ],
    ...overrides,
  };
}

function delta(overrides: Partial<TheiaDelta> = {}): TheiaDelta {
  return {
    id: 'delta-1',
    expert: 'code',
    baseVersion: 0,
    round: 1,
    confidence: 0.9,
    ops: [{ kind: 'replace', span: [0, 4], text: 'code' }],
    ...overrides,
  };
}

describe('theia phase', () => {
  it('accepts generate and denoise only', () => {
    expect(isTheiaPhase('generate')).toBe(true);
    expect(isTheiaPhase('denoise')).toBe(true);
    expect(isTheiaPhase('step')).toBe(false);
    expect(isTheiaPhase(undefined)).toBe(false);
  });
});

describe('theia canvas guard', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isTheiaCanvas(canvas())).toBe(true);
  });

  it('rejects overlapping, unsorted, and duplicate spans', () => {
    expect(
      isTheiaCanvas(
        canvas({
          spans: [
            { id: 'a', start: 0, end: 6, open: true },
            { id: 'b', start: 5, end: 9, open: true },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isTheiaCanvas(
        canvas({
          spans: [
            { id: 'b', start: 9, end: 13, open: true },
            { id: 'a', start: 0, end: 4, open: true },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isTheiaCanvas(
        canvas({
          spans: [
            { id: 'a', start: 0, end: 4, open: true },
            { id: 'a', start: 9, end: 13, open: true },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('rejects out-of-bounds spans and oversized text', () => {
    expect(isTheiaCanvas(canvas({ spans: [{ id: 'a', start: 0, end: 14, open: true }] }))).toBe(false);
    expect(isTheiaCanvas(canvas({ text: 'x'.repeat(MAX_THEIA_CANVAS_CHARS + 1) }))).toBe(false);
  });

  it('rejects too many spans', () => {
    const spans = Array.from({ length: MAX_THEIA_SPANS + 1 }, (_, index) => ({
      id: `s${index}`,
      start: index,
      end: index + 1,
      open: true,
    }));
    expect(isTheiaCanvas(canvas({ spans, text: 'x'.repeat(spans.length) }))).toBe(false);
  });
});

describe('theia delta guard', () => {
  it('accepts a replace delta', () => {
    expect(isTheiaDelta(delta())).toBe(true);
  });

  it('accepts optional token probabilities', () => {
    expect(
      isTheiaDelta(
        delta({
          ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [0.8, 0.9] }],
        }),
      ),
    ).toBe(true);
  });

  it('rejects unsupported ops, empty ops, and too many ops', () => {
    expect(isTheiaDelta(delta({ ops: [{ kind: 'insert', at: 0, text: 'x' } as never] }))).toBe(false);
    expect(isTheiaDelta(delta({ ops: [] }))).toBe(false);
    const ops = Array.from({ length: MAX_THEIA_DELTA_OPS + 1 }, () => ({
      kind: 'replace' as const,
      span: [0, 4] as [number, number],
      text: 'x',
    }));
    expect(isTheiaDelta(delta({ ops }))).toBe(false);
  });

  it('rejects bad confidence and oversized replacement text', () => {
    expect(isTheiaDelta(delta({ confidence: 1.1 }))).toBe(false);
    expect(isTheiaDelta(delta({ confidence: -0.1 }))).toBe(false);
    expect(
      isTheiaDelta(delta({ ops: [{ kind: 'replace', span: [0, 4], text: '' }] })),
    ).toBe(false);
    expect(
      isTheiaDelta(
        delta({
          ops: [{ kind: 'replace', span: [0, 4], text: 'x'.repeat(MAX_THEIA_DELTA_TEXT_CHARS + 1) }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects invalid token probabilities', () => {
    expect(
      isTheiaDelta(
        delta({
          ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [1.2] }],
        }),
      ),
    ).toBe(false);
    expect(
      isTheiaDelta(
        delta({
          ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [Number.NaN] }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects malformed ids and versions', () => {
    expect(isTheiaDelta(delta({ id: '' }))).toBe(false);
    expect(isTheiaDelta(delta({ expert: 'x'.repeat(65) }))).toBe(false);
    expect(isTheiaDelta(delta({ baseVersion: -1 }))).toBe(false);
    expect(isTheiaDelta(delta({ round: 1.5 }))).toBe(false);
  });
});
