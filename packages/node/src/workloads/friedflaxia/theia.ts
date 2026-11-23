import type {
  TheiaCanvas,
  TheiaCanvasSpan,
  TheiaChatMessage,
  TheiaDelta,
  TheiaInferencePayload,
  TheiaInferenceResult,
} from '@flaxia/sdk';
import { MAX_THEIA_RESULT_DELTAS, THEIA_DLLM_MODEL_ID, isTheiaDelta } from '@flaxia/sdk';
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
 * - replace-only edits,
 * - BD3LM-style 32-token blocks, one chunk at a time,
 * - low-confidence remasking with greedy top-1 commits,
 * - a bounded canvas because block attention is O(tokens²).
 */

/** BD3LM was trained with 32-token blocks. */
export const THEIA_BLOCK_SIZE = 32;
/**
 * The 0.6B validation model was trained at 512 tokens. The prompt plus the
 * padded block must fit; the host keeps a block round small.
 */
export const THEIA_MAX_CONTEXT_TOKENS = 512;
/**
 * Tokenizing a 64k-character canvas would run hundreds of prefix encodes just
 * to reject it, so the executor refuses long text up front.
 */
export const THEIA_MAX_CANVAS_CHARS = 16_000;
/** Denoise refinement steps per 32-token chunk. */
export const THEIA_DEFAULT_STEPS = 8;
export const THEIA_MAX_STEPS = 128;
/** Response budget for `phase: 'generate'`. */
export const THEIA_DEFAULT_NEW_TOKENS = 64;
export const THEIA_MAX_NEW_TOKENS = 256;
/** Candidates requested per position; the first one is committed. */
export const THEIA_TOPK = 8;
/** Right-context tokens included in a chunk's block. */
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

const CONTROL_TOKEN = /<\|[A-Za-z0-9_]+\|>/;

/**
 * Reject control markers in untrusted text.
 *
 * The tokenizer matches `<|im_start|>`-style tokens verbatim, so a message or
 * canvas that contains one could inject a turn. Theia has no need for them in
 * content: the executor adds the prompts itself.
 */
function assertNoControlTokens(text: string, where: string): void {
  if (CONTROL_TOKEN.test(text)) {
    throw new Error(`theia-inference: ${where} must not contain control tokens`);
  }
}

/** Qwen3 chat prompt with an assistant generation marker. */
export function buildChatTokens(
  model: DllmModel,
  messages: readonly TheiaChatMessage[],
): number[] {
  const imStart = requireToken(model, '<|im_start|>');
  const imEnd = requireToken(model, '<|im_end|>');
  const newline = encode(model, '\n');
  const ids: number[] = [];
  for (const message of messages) {
    assertNoControlTokens(message.content, 'message content');
    ids.push(imStart);
    ids.push(...encode(model, `${message.role}\n${message.content}`));
    ids.push(imEnd);
    ids.push(...newline);
  }
  ids.push(imStart);
  ids.push(...encode(model, 'assistant\n'));
  return ids;
}

/**
 * Tokenize the canvas and record where every span lands.
 *
 * The whole text is tokenized once. A span boundary that falls inside a BPE
 * pre-token cannot be represented as a token range, so the decoded range is
 * compared with the span text and a misaligned span is rejected instead of
 * silently replacing characters outside the span.
 */
export function tokenizeCanvas(model: DllmModel, canvas: TheiaCanvas): TheiaCanvasTokens {
  if (canvas.text.length > THEIA_MAX_CANVAS_CHARS) {
    throw new Error(
      `theia-inference: canvas text exceeds ${THEIA_MAX_CANVAS_CHARS} characters`,
    );
  }
  assertNoControlTokens(canvas.text, 'canvas text');
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
    const start = Math.min(common, tokens.length - 1);
    const end = Math.min(tokens.length, through.length);
    if (end <= start) {
      throw new Error(`theia-inference: canvas span ${span.id} has no tokens`);
    }
    const decoded = model.decode(tokens.slice(start, end)).trim();
    const expected = canvas.text.slice(span.start, span.end).trim();
    if (!expected || decoded !== expected) {
      throw new Error(
        `theia-inference: canvas span ${span.id} does not align to a token boundary; ` +
          'split the span so it starts and ends on a token',
      );
    }
    spans.push({ span, start, end });
    cursor = span.end;
  }
  return { tokens, spans };
}

interface DenoisedChunk {
  steps: number;
  confidence: number;
}

/**
 * Denoise one masked chunk with the MDLM transfer schedule.
 *
 * `steps` is capped to the number of masked positions: a step that commits
 * nothing would see the identical input and burn a full forward for nothing.
 */
async function denoiseChunk(
  model: DllmModel,
  tokens: number[],
  start: number,
  end: number,
  steps: number,
  options: TheiaDenoiseOptions,
  maskId: number,
): Promise<DenoisedChunk> {
  const positions: number[] = [];
  for (let position = start; position < end; position += 1) {
    tokens[position] = maskId;
    positions.push(position);
  }
  if (positions.length === 0) return { steps: 0, confidence: 0 };

  const totalSteps = Math.max(1, Math.min(steps, positions.length));
  const baseTransfer = Math.floor(positions.length / totalSteps);
  const remainder = positions.length % totalSteps;
  const blockEnd = Math.min(tokens.length, end + SPAN_CONTEXT_TOKENS);
  let remaining = positions;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let stepsRun = 0;

  for (let step = 0; step < totalSteps && remaining.length > 0; step += 1) {
    // positions.length / totalSteps >= 1 here, so every step commits at least
    // one token and no forward is wasted.
    const transfer = baseTransfer + (step >= totalSteps - remainder ? 1 : 0);
    const out = model.denoise_topk(tokens, remaining, start, blockEnd, THEIA_TOPK);
    const rows = remaining.map((position, row) => ({
      position,
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
    stepsRun += 1;
    await options.onStep?.();
  }

  return {
    steps: stepsRun,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Decode a generated range, dropping EOS padding.
 *
 * The model can emit newlines and EOS before the real answer and pads the rest
 * of a block with EOS. Leading whitespace/control padding is ignored; the first
 * EOS after real content ends the output.
 */
export function decodeSpan(
  model: DllmModel,
  tokens: readonly number[],
  start: number,
  end: number,
  eosId: number | undefined,
): string {
  let begin = start;
  let stop = end;
  let sawContent = false;
  for (let position = start; position < end; position += 1) {
    const id = tokens[position];
    if (eosId !== undefined && id === eosId) {
      if (sawContent) {
        stop = position;
        break;
      }
      begin = position + 1;
      continue;
    }
    if (!sawContent) {
      // A decoded token can be a newline or a space; those are padding until
      // the answer actually starts.
      const text = model.decode([id]);
      if (text.trim().length > 0) sawContent = true;
      else begin = position + 1;
    }
  }
  return model.decode(tokens.slice(begin, stop));
}

function deltaId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `theia-${crypto.randomUUID()}`;
  }
  return `theia-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RunTheiaOptions extends TheiaDenoiseOptions {
  /** Cache identity reported in the result; defaults to the pinned base dLLM. */
  modelId?: string;
}

/**
 * Run one `theia-inference` task against an already-loaded model.
 *
 * Throws on a payload the node cannot serve (`expert` not distributed yet,
 * canvas too large, a span that is not token-aligned) instead of silently
 * returning a base-model result under an expert's name.
 */
export async function runTheiaInference(
  model: DllmModel,
  payload: TheiaInferencePayload,
  options: RunTheiaOptions = {},
): Promise<TheiaInferenceResult> {
  const startedAt = performance.now();
  const phase = payload.phase ?? 'generate';
  const expert = payload.expert;
  const loadedExpert = model.loraExpert?.();
  if (expert !== undefined) {
    if (!loadedExpert || loadedExpert !== expert) {
      throw new Error(
        `theia-inference: LoRA expert ${expert} is not distributed yet (base model only)`,
      );
    }
  } else if (loadedExpert) {
    throw new Error(`theia-inference: this node serves expert ${loadedExpert}; expert id is required`);
  }

  const prompt = buildChatTokens(model, payload.messages);
  const maskId = requireToken(model, '<|mask|>');
  const eosId = model.eos_token_id?.();
  const steps = Math.max(1, Math.min(payload.steps ?? THEIA_DEFAULT_STEPS, THEIA_MAX_STEPS));
  const modelId = options.modelId ?? THEIA_DLLM_MODEL_ID;

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
    const denoised = await denoiseChunk(
      model,
      tokens,
      prompt.length,
      tokens.length,
      steps,
      options,
      maskId,
    );
    return {
      output: decodeSpan(model, tokens, prompt.length, tokens.length, eosId).trim(),
      model: modelId,
      steps: denoised.steps,
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
  const promptLength = prompt.length;
  const working = [...prompt, ...canvasTokens.tokens];
  const openSpans = canvasTokens.spans.filter(({ span, start, end }) => span.open && start < end);

  // Build blocks of at most one BD3LM block. A span that starts before the
  // current block ends but extends past it gets its own block; this prevents
  // "grouping" from chaining arbitrarily large blocks.
  const blocks: Array<{ start: number; end: number; spans: TheiaSpanTokens[] }> = [];
  for (const entry of openSpans) {
    const current = blocks[blocks.length - 1];
    if (!current || entry.start >= current.end) {
      blocks.push({
        start: entry.start,
        end: Math.max(entry.start + THEIA_BLOCK_SIZE, entry.end),
        spans: [entry],
      });
    } else if (entry.end <= current.end) {
      current.spans.push(entry);
    } else {
      blocks.push({
        start: entry.start,
        end: Math.max(entry.start + THEIA_BLOCK_SIZE, entry.end),
        spans: [entry],
      });
    }
  }

  const maxBlockEnd = blocks.reduce((max, block) => Math.max(max, block.end), 0);
  if (promptLength + maxBlockEnd > THEIA_MAX_CONTEXT_TOKENS) {
    throw new Error(
      `theia-inference: prompt (${promptLength}) + block (${maxBlockEnd}) exceed ` +
        `${THEIA_MAX_CONTEXT_TOKENS}; keep a block round small`,
    );
  }

  const deltas: TheiaDelta[] = [];
  const round = payload.round ?? 0;
  const expertName = expert ?? 'base';
  let stepsRun = 0;
  for (const block of blocks) {
    if (deltas.length >= MAX_THEIA_RESULT_DELTAS) break;
    let blockConfidence = 0;
    let blockTokens = 0;
    // Long spans (or a block extended past 32 tokens) are generated left to
    // right in 32-token chunks, so every forward matches the training block.
    for (let chunkStart = block.start; chunkStart < block.end; chunkStart += THEIA_BLOCK_SIZE) {
      const chunkEnd = Math.min(block.end, chunkStart + THEIA_BLOCK_SIZE);
      const absoluteEnd = promptLength + chunkEnd;
      while (working.length < absoluteEnd) working.push(maskId);
      const denoised = await denoiseChunk(
        model,
        working,
        promptLength + chunkStart,
        absoluteEnd,
        steps,
        options,
        maskId,
      );
      stepsRun += denoised.steps;
      const count = chunkEnd - chunkStart;
      blockConfidence += denoised.confidence * count;
      blockTokens += count;
    }

    for (const [index, entry] of block.spans.entries()) {
      if (deltas.length >= MAX_THEIA_RESULT_DELTAS) break;
      const spanStart = promptLength + entry.start;
      // Grow the last span only when it reaches the end of the canvas; growing
      // into real following text would duplicate it (the op covers only the
      // original span characters).
      const atCanvasEnd = entry.end === canvasTokens.tokens.length;
      const growTo =
        index === block.spans.length - 1 && atCanvasEnd ? block.end : entry.end;
      const text = decodeSpan(model, working, spanStart, promptLength + growTo, eosId).trim();
      if (!text) continue;
      const delta: TheiaDelta = {
        id: deltaId(),
        expert: expertName,
        baseVersion: canvas.version,
        round,
        ops: [{ kind: 'replace', span: [entry.span.start, entry.span.end], text }],
        confidence: clampConfidence(blockTokens > 0 ? blockConfidence / blockTokens : 0),
      };
      // The node must produce exactly what the host guard accepts.
      if (!isTheiaDelta(delta, canvas)) continue;
      deltas.push(delta);
    }
  }

  return {
    deltas,
    canvasVersion: canvas.version,
    round,
    model: modelId,
    steps: stepsRun,
    expert,
    phase,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
