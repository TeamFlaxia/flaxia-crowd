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
  TheiaChatMessage,
  TheiaDelta,
  TheiaEditOp,
  TheiaInferencePayload,
  TheiaMergeRule,
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
/**
 * Manifest id of the pinned base dLLM. The node reports it in `modelCache`
 * (with the adapter id in T5) so the coordinator can place a task on a warm
 * node; keep it in sync with FriedFlaxia's `model-manifest.json`.
 */
export const THEIA_DLLM_MODEL_ID = 'qwen3-0.6b-diffusion-bd3lm';
/** Bound the deltas a node may return in one denoise result. */
export const MAX_THEIA_RESULT_DELTAS = 64;
/** Bound the conversation handed to one task. */
export const MAX_THEIA_MESSAGES = 64;
export const MAX_THEIA_MESSAGE_CHARS = 64_000;
export const MAX_THEIA_MESSAGES_TOTAL_CHARS = 64_000;
export const MAX_THEIA_MODEL_CHARS = 128;

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

export interface TheiaDeltaOptions {
  /** Allow a delta to target a committed span (host revision mode). */
  allowRevisions?: boolean;
}

/**
 * Structural and canvas-aware delta validation.
 *
 * The canvas is required because v1 deltas must target an existing editable
 * span; checking only the op shape would let a node emit deltas the host
 * discards wholesale.
 */
export function isTheiaDelta(
  value: unknown,
  canvas: TheiaCanvas,
  options: TheiaDeltaOptions = {},
): value is TheiaDelta {
  if (!isTheiaCanvas(canvas)) return false;
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
  if (
    value.entropy !== undefined &&
    (typeof value.entropy !== 'number' || !Number.isFinite(value.entropy))
  ) {
    return false;
  }
  if (
    value.ageRounds !== undefined &&
    (typeof value.ageRounds !== 'number' || !Number.isFinite(value.ageRounds))
  ) {
    return false;
  }
  if (!Array.isArray(value.ops) || value.ops.length === 0) return false;
  if (value.ops.length > MAX_THEIA_DELTA_OPS) return false;

  const editable = new Map<string, boolean>();
  for (const span of canvas.spans) {
    editable.set(`${span.start}:${span.end}`, span.open);
  }
  const seen = new Set<string>();
  for (const raw of value.ops) {
    if (!isEditOp(raw)) return false;
    const key = `${raw.span[0]}:${raw.span[1]}`;
    const open = editable.get(key);
    if (open === undefined) return false;
    if (!open && options.allowRevisions !== true) return false;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isChatMessage(value: unknown): value is TheiaChatMessage {
  if (!isRecord(value)) return false;
  if (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant') return false;
  if (typeof value.content !== 'string' || value.content.length > MAX_THEIA_MESSAGE_CHARS) {
    return false;
  }
  if (value.id !== undefined && !isShortString(value.id, 128)) return false;
  if (
    value.createdAt !== undefined &&
    (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt))
  ) {
    return false;
  }
  return true;
}

function isMergeRule(value: unknown): value is TheiaMergeRule {
  return (
    value === 'confidence-count' ||
    value === 'logit-mean' ||
    value === 'probability-mean' ||
    value === 'poe'
  );
}

/**
 * Validate a `theia-inference` payload before submit.
 *
 * `denoise` requires a canvas; `generate` must not carry one. Round/step defaults
 * are applied by the host, not here.
 */
export function isTheiaInferencePayload(value: unknown): value is TheiaInferencePayload {
  if (!isRecord(value)) return false;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_THEIA_MESSAGES
  ) {
    return false;
  }
  let chars = 0;
  for (const message of value.messages) {
    if (!isChatMessage(message)) return false;
    chars += message.content.length;
  }
  if (chars > MAX_THEIA_MESSAGES_TOTAL_CHARS) return false;
  if (!isShortString(value.model, MAX_THEIA_MODEL_CHARS)) return false;

  const phase = value.phase === undefined ? 'generate' : value.phase;
  if (!isTheiaPhase(phase)) return false;
  if (value.expert !== undefined && !isShortString(value.expert, 64)) return false;
  if (phase === 'denoise') {
    if (!isTheiaCanvas(value.canvas)) return false;
  } else if (value.canvas !== undefined) {
    return false;
  }

  if (value.round !== undefined && !isIntegerInRange(value.round, 0, 1_000_000)) return false;
  if (value.steps !== undefined && !isIntegerInRange(value.steps, 1, 256)) return false;
  if (value.maxSteps !== undefined && !isIntegerInRange(value.maxSteps, 1, 4096)) return false;
  if (value.maxNewTokens !== undefined && !isIntegerInRange(value.maxNewTokens, 1, 256)) {
    return false;
  }
  if (
    value.strength !== undefined &&
    (typeof value.strength !== 'number' || !Number.isFinite(value.strength) || value.strength < 0)
  ) {
    return false;
  }
  if (
    value.temperature !== undefined &&
    (typeof value.temperature !== 'number' ||
      !Number.isFinite(value.temperature) ||
      value.temperature <= 0)
  ) {
    return false;
  }
  if (value.mergeRule !== undefined && !isMergeRule(value.mergeRule)) return false;
  if (value.theia !== undefined) {
    if (!isRecord(value.theia)) return false;
    if (value.theia.preferWarm !== undefined && typeof value.theia.preferWarm !== 'boolean') {
      return false;
    }
  }
  return true;
}
