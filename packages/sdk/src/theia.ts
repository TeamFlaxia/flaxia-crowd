/**
 * Runtime guards for the `theia-inference` contract.
 *
 * The payload arrives from an API caller and deltas come back from Crowd nodes,
 * so both sides validate with the same bounds. Keeping the limits here (rather
 * than in the worker) means the SDK and the node cannot drift apart.
 */

import type {
  TheiaCanvas,
  TheiaCanvasSpan,
  TheiaDelta,
  TheiaEditOp,
  TheiaPhase,
} from './types';

/** Bound the canvas text before it is copied into a task payload. */
export const MAX_THEIA_CANVAS_CHARS = 64_000;
/** Bound the number of span slots one canvas may carry. */
export const MAX_THEIA_SPANS = 512;
/** Bound one delta's edit count. */
export const MAX_THEIA_DELTA_OPS = 8;
/** Bound one replacement's text length. */
export const MAX_THEIA_DELTA_TEXT_CHARS = 512;
/** Bound the optional per-token probabilities attached to one op. */
export const MAX_THEIA_DELTA_TOKEN_PROBS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isTheiaPhase(value: unknown): value is TheiaPhase {
  return value === 'generate' || value === 'denoise';
}

function isSpan(value: unknown, textLength: number): value is TheiaCanvasSpan {
  if (!isRecord(value)) return false;
  return (
    isShortString(value.id, 64) &&
    isIntegerInRange(value.start, 0, textLength) &&
    isIntegerInRange(value.end, 0, textLength) &&
    value.start < value.end &&
    typeof value.open === 'boolean'
  );
}

export function isTheiaCanvas(value: unknown): value is TheiaCanvas {
  if (!isRecord(value)) return false;
  if (!isIntegerInRange(value.version, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (typeof value.text !== 'string' || value.text.length > MAX_THEIA_CANVAS_CHARS) return false;
  if (!Array.isArray(value.spans) || value.spans.length > MAX_THEIA_SPANS) return false;
  let cursor = 0;
  const ids = new Set<string>();
  for (const raw of value.spans) {
    if (!isSpan(raw, value.text.length)) return false;
    if (raw.start < cursor || ids.has(raw.id)) return false;
    ids.add(raw.id);
    cursor = raw.end;
  }
  return true;
}

function isEditOp(value: unknown): value is TheiaEditOp {
  if (!isRecord(value) || value.kind !== 'replace') return false;
  if (!Array.isArray(value.span) || value.span.length !== 2) return false;
  const [start, end] = value.span;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end) return false;
  if (typeof value.text !== 'string' || value.text.length === 0) return false;
  if (value.text.length > MAX_THEIA_DELTA_TEXT_CHARS) return false;
  if (value.tokenProbs === undefined) return true;
  if (!Array.isArray(value.tokenProbs) || value.tokenProbs.length > MAX_THEIA_DELTA_TOKEN_PROBS) {
    return false;
  }
  return value.tokenProbs.every(
    (probability) =>
      typeof probability === 'number' &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1,
  );
}

export function isTheiaDelta(value: unknown): value is TheiaDelta {
  if (!isRecord(value)) return false;
  if (!isShortString(value.id, 128) || !isShortString(value.expert, 64)) return false;
  if (!isIntegerInRange(value.baseVersion, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isIntegerInRange(value.round, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    return false;
  }
  if (value.entropy !== undefined && typeof value.entropy !== 'number') return false;
  if (value.ageRounds !== undefined && typeof value.ageRounds !== 'number') return false;
  if (!Array.isArray(value.ops) || value.ops.length === 0) return false;
  if (value.ops.length > MAX_THEIA_DELTA_OPS) return false;
  return value.ops.every(isEditOp);
}
