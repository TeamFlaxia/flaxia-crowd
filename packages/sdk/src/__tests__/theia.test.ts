import { describe, expect, it } from 'vitest';
import {
  MAX_THEIA_CANVAS_CHARS,
  MAX_THEIA_DELTA_OPS,
  MAX_THEIA_DELTA_TEXT_CHARS,
  MAX_THEIA_MESSAGES,
  MAX_THEIA_SPANS,
  isTheiaCanvas,
  isTheiaDelta,
  isTheiaInferencePayload,
  isTheiaPhase,
} from '../theia';
import type { TheiaCanvas, TheiaDelta, TheiaInferencePayload } from '../types';

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

function payload(overrides: Partial<TheiaInferencePayload> = {}): TheiaInferencePayload {
  return {
    messages: [{ role: 'user', content: 'hello' }],
    model: 'qwen-dlm-4b',
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
  const c = canvas();

  it('accepts a replace on an open span', () => {
    expect(isTheiaDelta(delta(), c)).toBe(true);
  });

  it('requires the op to match an editable span', () => {
    expect(
      isTheiaDelta(delta({ ops: [{ kind: 'replace', span: [4, 9], text: 'gap' }] }), c),
    ).toBe(false);
    expect(
      isTheiaDelta(delta({ ops: [{ kind: 'replace', span: [0, 1_000_000], text: 'huge' }] }), c),
    ).toBe(false);
  });

  it('rejects a committed span unless revisions are enabled', () => {
    const committed = canvas({
      spans: [
        { id: 'a', start: 0, end: 4, open: false },
        { id: 'b', start: 9, end: 13, open: true },
      ],
    });
    expect(isTheiaDelta(delta(), committed)).toBe(false);
    expect(isTheiaDelta(delta(), committed, { allowRevisions: true })).toBe(true);
  });

  it('rejects a delta against a zero-span canvas', () => {
    expect(isTheiaDelta(delta(), canvas({ text: '', spans: [] }))).toBe(false);
  });

  it('rejects duplicate targets inside one delta', () => {
    expect(
      isTheiaDelta(
        delta({
          ops: [
            { kind: 'replace', span: [0, 4], text: 'a' },
            { kind: 'replace', span: [0, 4], text: 'b' },
          ],
        }),
        c,
      ),
    ).toBe(false);
  });

  it('accepts optional token probabilities', () => {
    expect(
      isTheiaDelta(
        delta({
          ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [0.8, 0.9] }],
        }),
        c,
      ),
    ).toBe(true);
  });

  it('rejects unsupported ops, empty ops, and too many ops', () => {
    expect(
      isTheiaDelta(delta({ ops: [{ kind: 'insert', at: 0, text: 'x' } as never] }), c),
    ).toBe(false);
    expect(isTheiaDelta(delta({ ops: [] }), c)).toBe(false);
    const ops = Array.from({ length: MAX_THEIA_DELTA_OPS + 1 }, () => ({
      kind: 'replace' as const,
      span: [0, 4] as [number, number],
      text: 'x',
    }));
    expect(isTheiaDelta(delta({ ops }), c)).toBe(false);
  });

  it('rejects bad confidence and oversized replacement text', () => {
    expect(isTheiaDelta(delta({ confidence: 1.1 }), c)).toBe(false);
    expect(isTheiaDelta(delta({ confidence: -0.1 }), c)).toBe(false);
    expect(
      isTheiaDelta(delta({ ops: [{ kind: 'replace', span: [0, 4], text: '' }] }), c),
    ).toBe(false);
    expect(
      isTheiaDelta(
        delta({
          ops: [
            { kind: 'replace', span: [0, 4], text: 'x'.repeat(MAX_THEIA_DELTA_TEXT_CHARS + 1) },
          ],
        }),
        c,
      ),
    ).toBe(false);
  });

  it('rejects invalid token probabilities and non-finite metadata', () => {
    expect(
      isTheiaDelta(
        delta({ ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [1.2] }] }),
        c,
      ),
    ).toBe(false);
    expect(
      isTheiaDelta(
        delta({ ops: [{ kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [Number.NaN] }] }),
        c,
      ),
    ).toBe(false);
    expect(
      isTheiaDelta(
        delta({
          ops: [
            { kind: 'replace', span: [0, 4], text: 'code', tokenProbs: [0.5] },
          ],
        }),
        c,
      ),
    ).toBe(true);
    expect(isTheiaDelta(delta({ entropy: Number.NaN }), c)).toBe(false);
    expect(isTheiaDelta(delta({ entropy: Number.POSITIVE_INFINITY }), c)).toBe(false);
    expect(isTheiaDelta(delta({ ageRounds: Number.NaN }), c)).toBe(false);
    expect(isTheiaDelta(delta({ ageRounds: Number.POSITIVE_INFINITY }), c)).toBe(false);
  });

  it('rejects malformed ids and versions', () => {
    expect(isTheiaDelta(delta({ id: '' }), c)).toBe(false);
    expect(isTheiaDelta(delta({ expert: 'x'.repeat(65) }), c)).toBe(false);
    expect(isTheiaDelta(delta({ baseVersion: -1 }), c)).toBe(false);
    expect(isTheiaDelta(delta({ round: 1.5 }), c)).toBe(false);
  });
});

describe('theia payload guard', () => {
  it('accepts generate by default and rejects a canvas in generate mode', () => {
    expect(isTheiaInferencePayload(payload())).toBe(true);
    expect(isTheiaInferencePayload(payload({ canvas: canvas() }))).toBe(false);
  });

  it('requires a canvas in denoise mode', () => {
    expect(isTheiaInferencePayload(payload({ phase: 'denoise' }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ phase: 'denoise', canvas: canvas() }))).toBe(true);
  });

  it('bounds the conversation', () => {
    expect(isTheiaInferencePayload(payload({ messages: [] }))).toBe(false);
    expect(
      isTheiaInferencePayload(
        payload({
          messages: Array.from({ length: MAX_THEIA_MESSAGES + 1 }, () => ({
            role: 'user' as const,
            content: 'x',
          })),
        }),
      ),
    ).toBe(false);
    expect(
      isTheiaInferencePayload(payload({ messages: [{ role: 'user', content: 'x'.repeat(64_001) }] })),
    ).toBe(false);
    expect(
      isTheiaInferencePayload(
        payload({
          messages: [
            { role: 'user', content: 'x'.repeat(33_000) },
            { role: 'user', content: 'y'.repeat(33_000) },
          ],
        }),
      ),
    ).toBe(false);
    expect(isTheiaInferencePayload(payload({ model: 'x'.repeat(129) }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ maxSteps: 0 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ maxSteps: 5000 }))).toBe(false);
  });

  it('rejects invalid phase, expert, and numeric options', () => {
    expect(isTheiaInferencePayload(payload({ phase: 'step' as never }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ phase: null as never }))).toBe(false);
    expect(
      isTheiaInferencePayload(
        payload({
          messages: [{ role: 'user', content: 'hi', id: 'm1', createdAt: 1 }],
        }),
      ),
    ).toBe(true);
    expect(isTheiaInferencePayload(payload({ expert: 'x'.repeat(65) }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ round: -1 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ steps: 0 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ steps: 257 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ strength: -1 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ temperature: 0 }))).toBe(false);
    expect(isTheiaInferencePayload(payload({ mergeRule: 'nope' as never }))).toBe(false);
    expect(
      isTheiaInferencePayload(payload({ theia: { preferWarm: 'yes' as never } })),
    ).toBe(false);
  });
});
