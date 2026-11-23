import type {
  TheiaCanvas,
  TheiaCanvasSpan,
  TheiaChatMessage,
  TheiaDelta,
  TheiaInferencePayload,
  TheiaInferenceResult,
} from '@flaxia/sdk';
import type { DllmModel } from '../../vendor/friedflaxia/types';

/**
 * Theia's masked-diffusion executor.
 *
 * One task is one star-topology round: the node receives the host's canvas
 * snapshot, denoises the open spans with one expert, and returns `replace`
 * deltas. There is no peer transport, layer split or session state.
 *
 * v1 is deliberately conservative:
 * - one base dLLM plus (later) one LoRA adapter per task,
 * - replace-only edits with the span's token count as a soft length budget,
 * - low-confidence remasking, greedy top-1 commits,
 * - a bounded canvas because the block attention is O(tokens²).
 */

/** BD3LM was trained with 32-token blocks. */
export const THEIA_BLOCK_SIZE = 32;
/**
 * The 0.6B validation model was trained at 512 tokens. The prompt plus canvas
 * must fit; the host keeps a block round small instead of sending a whole chat.
 */
export const THEIA_MAX_CONTEXT_TOKENS = 512;
/** Denoise refinement steps in one task. */
export const THEIA_DEFAULT_STEPS = 8;
export const THEIA_MAX_STEPS = 128;
/** Response budget for `phase: 'generate'`. */
export const THEIA_DEFAULT_NEW_TOKENS = 64;
export const THEIA_MAX_NEW_TOKENS = 256;
/** Candidates requested per position; the first one is committed. */
export const THEIA_TOPK = 8;
/** Left/right context tokens included in a span's block. */
const SPAN_CONTEXT_TOKENS = 32;

export interface TheiaDenoiseOptions {
  /** Called between denoise steps so the worker can hold its CPU duty cycle. */
  onStep?: () => void | Promise<void>;
}

export interface TheiaSpanTokens {
  span: TheiaCanvasSpan;
  /** Token range `[start, end)` in the canvas token sequence. */
  start: number;
  end: number;
}

export interface TheiaCanvasTokens {
  tokens: number[];
  spans: TheiaSpanTokens[];
}

function requireToken(model: DllmModel, token: string): number {
  const id = model.token_id(token);
  if (id === undefined) {
    throw new Error(`theia-inference: model tokenizer has no ${token}`);
  }
  return id;
}

function encode(model: DllmModel, text: string): number[] {
  return Array.from(model.encode(text, false));
}

/** Qwen3 chat prompt with an optional assistant generation prompt. */
export function buildChatTokens(
  model: DllmModel,
  messages: readonly TheiaChatMessage[],
  addGenerationPrompt: boolean,
): number[] {
  const imStart = requireToken(model, '<|im_start|>');
  const imEnd = requireToken(model, '<|im_end|>');
  const newline = encode(model, '\n');
  const ids: number[] = [];
  for (const message of messages) {
    ids.push(imStart);
    ids.push(...encode(model, `${message.role}\n${message.content}`));
    ids.push(imEnd);
    ids.push(...newline);
  }
  if (addGenerationPrompt) {
    ids.push(imStart);
    ids.push(...encode(model, 'assistant\n'));
  }
  return ids;
}

/**
 * Tokenize the canvas and record where every span lands.
 *
 * Segments are encoded independently so a span boundary is also a token
 * boundary. This is what lets the executor map a UTF-16 `[start, end)` span to
 * a token range without a character-offset tokenizer.
 */
export function tokenizeCanvas(model: DllmModel, canvas: TheiaCanvas): TheiaCanvasTokens {
  // Tokenize the whole text once: segment-wise encoding turns the space before
  // a span into a standalone "Ġ" token, which the model never saw in training
  // (it predicts "ĠParis", not a bare word after a split space).
  const tokens = encode(model, canvas.text);
  const spans: TheiaSpanTokens[] = [];
  let cursor = 0;
  for (const span of canvas.spans) {
    if (span.start < cursor || span.end > canvas.text.length || span.start >= span.end) {
      throw new Error(`theia-inference: canvas span ${span.id} is out of bounds`);
    }
    const prefix = encode(model, canvas.text.slice(0, span.start));
    const through = encode(model, canvas.text.slice(0, span.end));
    let common = 0;
    while (common < prefix.length && common < through.length && prefix[common] === through[common]) {
      common += 1;
    }
    // The boundary token can merge the trailing space with the span's first
    // character, so the span starts at the first token that differs.
    const start = Math.min(common, tokens.length - 1);
    const end = Math.min(tokens.length, through.length);
    if (end <= start) {
      throw new Error(`theia-inference: canvas span ${span.id} has no tokens`);
    }
    spans.push({ span, start, end });
    cursor = span.end;
  }
  return { tokens, spans };
}

interface DenoisedRange {
  tokens: number[];
  text: string;
  confidence: number;
}

/**
 * Denoise `[start, end)` with low-confidence remasking.
 *
 * The block is the span plus a little right context: the span sees the clean
 * prompt/prefix and the surrounding canvas, while nothing after `end + 32` is
 * read. Positions are committed greedily, most-confident first, so the
 * remaining masks shrink predictably each step.
 */
async function denoiseRange(
  model: DllmModel,
  tokens: number[],
  start: number,
  end: number,
  steps: number,
  options: TheiaDenoiseOptions,
  maskId: number,
  eosId: number | undefined,
): Promise<DenoisedRange> {
  const positions: number[] = [];
  for (let position = start; position < end; position += 1) {
    tokens[position] = maskId;
    positions.push(position);
  }
  if (positions.length === 0) {
    return { tokens, text: '', confidence: 0 };
  }

  const blockEnd = Math.min(tokens.length, end + SPAN_CONTEXT_TOKENS);
  let remaining = positions;
  let confidenceSum = 0;
  let confidenceCount = 0;
  const totalSteps = Math.max(1, Math.min(steps, THEIA_MAX_STEPS));
  // MDLM/BD3LM transfer schedule: spread the masks evenly over the steps and
  // only commit the remainder in the last few. A 1-token span must stay masked
  // for the early steps so the model can refine it, instead of committing a
  // low-confidence first guess immediately.
  const baseTransfer = Math.floor(positions.length / totalSteps);
  const remainder = positions.length % totalSteps;
  for (let step = 0; step < totalSteps && remaining.length > 0; step += 1) {
    const out = model.denoise_topk(tokens, remaining, start, blockEnd, THEIA_TOPK);
    const transfer = baseTransfer + (step >= totalSteps - remainder ? 1 : 0);
    if (transfer > 0) {
      const rows = remaining.map((position, row) => ({
        position,
        row,
        probability: Number(out.probabilities[row * out.topK] ?? 0),
        token: Number(out.tokenIds[row * out.topK] ?? 0),
      }));
      rows.sort((a, b) => b.probability - a.probability || a.position - b.position);
      const committed = new Set<number>();
      for (const row of rows.slice(0, transfer)) {
        tokens[row.position] = row.token;
        confidenceSum += row.probability;
        confidenceCount += 1;
        committed.add(row.position);
      }
      remaining = remaining.filter((position) => !committed.has(position));
    }
    await options.onStep?.();
  }

  // Anything still masked (steps ran out) gets one greedy pass so the span is
  // complete; its confidence is the top-1 probability.
  if (remaining.length > 0) {
    const out = model.denoise_topk(tokens, remaining, start, blockEnd, 1);
    remaining.forEach((position, row) => {
      tokens[position] = Number(out.tokenIds[row] ?? 0);
      confidenceSum += Number(out.probabilities[row] ?? 0);
      confidenceCount += 1;
    });
  }

  const eosAt = eosId === undefined ? -1 : tokens.indexOf(eosId, start);
  const stop = eosAt >= 0 ? Math.min(end, eosAt) : end;
  const decodeEnd = stop > start ? stop : end;
  const text = model.decode(tokens.slice(start, decodeEnd));
  return {
    tokens,
    text,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
  };
}

/**
 * Decode a generated span, dropping EOS padding.
 *
 * The model can emit EOS before the real answer (the assistant turn starts
 * with newlines), and pads the remainder of a block with EOS. Only an EOS that
 * follows some content marks the end; leading EOS tokens are ignored.
 */
export function decodeSpan(
  model: DllmModel,
  tokens: readonly number[],
  start: number,
  end: number,
  eosId: number | undefined,
): string {
  let stop = end;
  if (eosId !== undefined) {
    let sawContent = false;
    for (let position = start; position < end; position += 1) {
      if (tokens[position] === eosId) {
        if (sawContent) {
          stop = position;
          break;
        }
      } else {
        sawContent = true;
      }
    }
  }
  return model.decode(tokens.slice(start, stop));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function cleanText(text: string): string {
  return text.trim();
}

function deltaId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `theia-${crypto.randomUUID()}`;
  }
  return `theia-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RunTheiaOptions extends TheiaDenoiseOptions {
  /** Override for tests; defaults to the pinned payload expert contract. */
  expert?: string;
}

/**
 * Run one `theia-inference` task against an already-loaded model.
 *
 * Throws on a payload the node cannot serve (`expert` not distributed yet,
 * canvas too large) instead of silently returning a base-model result under an
 * expert's name.
 */
export async function runTheiaInference(
  model: DllmModel,
  payload: TheiaInferencePayload,
  options: RunTheiaOptions = {},
): Promise<TheiaInferenceResult> {
  const startedAt = performance.now();
  const phase = payload.phase ?? 'generate';
  const expert = payload.expert;
  if (expert !== undefined) {
    const loadedExpert = model.loraExpert?.();
    if (!loadedExpert || loadedExpert !== expert) {
      throw new Error(
        `theia-inference: LoRA expert ${expert} is not distributed yet (base model only)`,
      );
    }
  }

  // Both phases start the assistant turn: a denoise canvas is the assistant
  // response being edited, not another user message.
  const prompt = buildChatTokens(model, payload.messages, true);
  const maskId = requireToken(model, '<|mask|>');
  const eosId = model.eos_token_id?.();
  const steps = Math.max(1, Math.min(payload.steps ?? THEIA_DEFAULT_STEPS, THEIA_MAX_STEPS));

  if (phase === 'generate') {
    const newTokens = Math.max(
      1,
      Math.min(payload.maxNewTokens ?? THEIA_DEFAULT_NEW_TOKENS, THEIA_MAX_NEW_TOKENS),
    );
    if (prompt.length + newTokens > THEIA_MAX_CONTEXT_TOKENS) {
      throw new Error(
        `theia-inference: prompt (${prompt.length}) + new tokens (${newTokens}) exceed ${THEIA_MAX_CONTEXT_TOKENS}`,
      );
    }
    const tokens = [...prompt, ...new Array(newTokens).fill(maskId)];
    const denoised = await denoiseRange(
      model,
      tokens,
      prompt.length,
      tokens.length,
      steps,
      options,
      maskId,
      eosId,
    );
    return {
      output: cleanText(denoised.text),
      model: payload.model,
      steps,
      expert,
      phase,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  const canvas = payload.canvas;
  if (!canvas) {
    throw new Error('theia-inference: denoise requires a canvas');
  }
  const canvasTokens = tokenizeCanvas(model, canvas);
  if (prompt.length + canvasTokens.tokens.length > THEIA_MAX_CONTEXT_TOKENS) {
    throw new Error(
      `theia-inference: prompt (${prompt.length}) + canvas (${canvasTokens.tokens.length}) ` +
        `exceed ${THEIA_MAX_CONTEXT_TOKENS} tokens; keep a block round small`,
    );
  }

  // Group open spans into left-to-right 32-token blocks. Each block is fully
  // masked, matching BD3LM training, and later blocks condition on the tokens
  // generated by earlier ones.
  const promptLength = prompt.length;
  const working = [...prompt, ...canvasTokens.tokens];
  const openSpans = canvasTokens.spans.filter(({ span, start, end }) => span.open && start < end);
  const blocks: Array<{ start: number; end: number; spans: TheiaSpanTokens[] }> = [];
  for (const entry of openSpans) {
    const current = blocks[blocks.length - 1];
    if (current && entry.start < current.end) {
      current.end = Math.max(current.end, entry.start + THEIA_BLOCK_SIZE);
      current.spans.push(entry);
    } else {
      blocks.push({
        start: entry.start,
        end: entry.start + THEIA_BLOCK_SIZE,
        spans: [entry],
      });
    }
  }

  const deltas: TheiaDelta[] = [];
  const round = payload.round ?? 0;
  const expertName = expert ?? 'base';
  for (const block of blocks) {
    const start = promptLength + block.start;
    const end = promptLength + block.end;
    while (working.length < end) working.push(maskId);
    const denoised = await denoiseRange(
      model,
      working,
      start,
      end,
      steps,
      options,
      maskId,
      eosId,
    );
    for (const [index, entry] of block.spans.entries()) {
      const spanStart = promptLength + entry.start;
      // The last span may grow into the rest of the generated block: a short
      // placeholder cannot hold a full answer otherwise, and v1 allows a
      // replacement to change the span length when committed.
      const growTo = index === block.spans.length - 1 ? block.end : entry.end;
      const spanEnd = promptLength + growTo;
      const text = cleanText(decodeSpan(model, working, spanStart, spanEnd, eosId));
      if (!text) continue;
      deltas.push({
        id: deltaId(),
        expert: expertName,
        baseVersion: canvas.version,
        round,
        ops: [{ kind: 'replace', span: [entry.span.start, entry.span.end], text }],
        confidence: clampConfidence(denoised.confidence),
      });
    }
  }

  return {
    deltas,
    canvasVersion: canvas.version,
    round,
    model: payload.model,
    steps,
    expert,
    phase,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
