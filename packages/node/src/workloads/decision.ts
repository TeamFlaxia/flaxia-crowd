import type {
  AiInferencePayload,
  AiInferenceResult,
  DecisionAnswer,
  DecisionQuestions,
} from '@flaxia/sdk';
import { resolveAiModel } from './ai-model-registry';
import { fetchGuarded } from '../executor/egress-guard';

/**
 * Decision-model driver for d1-omni-600M (LiquidAI).
 *
 * d1-omni is a `trust_remote_code` AutoModel, not a transformers.js pipeline
 * task, so it cannot go through the generic `pipeline()` path in
 * ai-inference.ts. This module loads it once (single-threaded wasm, the same
 * memory guard as the other workloads) and answers a batch of named
 * questions in one forward pass, returning full probability distributions.
 *
 * Multimodal fetch contract mirrors NSFW `imageUrl`: media travels as
 * publicly fetchable URLs, the node fetches bytes itself via the egress
 * guard (https only, public hosts only, bounded size/timeout).
 */

const DECISION_MODEL_ID = 'LiquidAI/d1-omni-600M';

/** d1-omni audio contract: 16kHz mono, one clip per call. */
export const DECISION_AUDIO_SAMPLE_RATE = 16_000;
export const DECISION_AUDIO_MAX_SECONDS = 30;
const DECISION_AUDIO_MAX_SAMPLES = DECISION_AUDIO_SAMPLE_RATE * DECISION_AUDIO_MAX_SECONDS;

/** Question/option bounds: keep one forward pass cheap and answers stable. */
export const DECISION_MAX_QUESTIONS = 8;
export const DECISION_MAX_OPTIONS = 64;
export const DECISION_MAX_STATE_CHARS = 20_000;
export const DECISION_MAX_MEDIA_URLS = 8;

/** Per-file media caps (compressed bytes). */
export const MAX_DECISION_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DECISION_AUDIO_BYTES = 8 * 1024 * 1024;
/** Bound decoded pixels per image before the model sees it (RGBA ~4 bytes/pixel). */
export const MAX_DECISION_IMAGE_PIXELS = 16 * 1024 * 1024;
/** Media fetch timeout. */
const DECISION_FETCH_TIMEOUT_MS = 20_000;

let decisionModel: any = null;
let decisionLoadPromise: Promise<any> | null = null;

export const releaseCache = (): void => {
  const current = decisionModel;
  decisionModel = null;
  decisionLoadPromise = null;
  if (!current) return;
  // Dispose the wasm model explicitly; dropping the reference only leaves the
  // buffers to GC and keeps the wasm heap pinned until then.
  void (async () => {
    try { current.dispose?.(); } catch {}
  })();
};

function assertDecisionPayload(payload: {
  decision?: {
    state?: string | null;
    questions?: DecisionQuestions;
    imageUrls?: string[];
    audioUrl?: string;
  };
}): { state: string | null; questions: DecisionQuestions; imageUrls: string[]; audioUrl?: string } {
  const decision = payload.decision;
  if (!decision) {
    throw new Error('decision: payload.decision is required for d1-omni');
  }
  const questions = decision.questions;
  if (!questions || typeof questions !== 'object') {
    throw new Error('decision: questions must be an object');
  }
  const names = Object.keys(questions);
  if (names.length === 0 || names.length > DECISION_MAX_QUESTIONS) {
    throw new Error(`decision: questions must hold 1..${DECISION_MAX_QUESTIONS} entries`);
  }
  for (const [name, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object') throw new Error(`decision: question "${name}" must be an object`);
    if (q.type !== 'noul' && q.type !== 'choice' && q.type !== 'score') {
      throw new Error(`decision: question "${name}" has unknown type ${JSON.stringify(q.type)}`);
    }
    if (typeof q.instructions !== 'string' || !q.instructions) {
      throw new Error(`decision: question "${name}" needs instructions`);
    }
    if (q.type === 'choice') {
      const criteria = q.criteria as Record<string, string> | undefined;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        throw new Error(`decision: question "${name}" needs criteria object`);
      }
      const options = Object.keys(criteria);
      if (options.length < 2 || options.length > DECISION_MAX_OPTIONS) {
        throw new Error(`decision: question "${name}" needs 2..${DECISION_MAX_OPTIONS} options`);
      }
      for (const desc of options.map((k) => (criteria as Record<string, string>)[k])) {
        if (typeof desc !== 'string') throw new Error(`decision: question "${name}" criteria must be strings`);
      }
    }
    if (q.type === 'score') {
      const criteria = q.criteria as string[] | undefined;
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
        throw new Error(`decision: question "${name}" needs 2..10 score levels`);
      }
      for (const level of criteria) {
        if (typeof level !== 'string') throw new Error(`decision: question "${name}" levels must be strings`);
      }
    }
  }

  const state = decision.state ?? null;
  if (state !== null && typeof state !== 'string') {
    throw new Error('decision: state must be a string or null');
  }
  if (typeof state === 'string' && state.length > DECISION_MAX_STATE_CHARS) {
    throw new Error(`decision: state exceeds ${DECISION_MAX_STATE_CHARS} characters`);
  }

  const imageUrls = decision.imageUrls ?? [];
  if (!Array.isArray(imageUrls) || imageUrls.length > DECISION_MAX_MEDIA_URLS) {
    throw new Error(`decision: imageUrls must hold 0..${DECISION_MAX_MEDIA_URLS} URLs`);
  }
  for (const url of imageUrls) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('decision: imageUrls must be https:// URLs');
    }
  }
  const audioUrl = decision.audioUrl;
  if (audioUrl !== undefined && (typeof audioUrl !== 'string' || !audioUrl.startsWith('https://'))) {
    throw new Error('decision: audioUrl must be an https:// URL');
  }
  // Model hard limit: one call carries images OR audio, never both.
  if (imageUrls.length > 0 && audioUrl) {
    throw new Error('decision: pass images or audio in one call, not both');
  }
  // State-less calls must still carry media as the state.
  if ((state === null || state === '') && imageUrls.length === 0 && !audioUrl) {
    throw new Error('decision: null state needs at least one image or an audio clip');
  }
  return { state, questions, imageUrls: [...imageUrls], audioUrl };
}

async function loadDecisionModel(modelId: string): Promise<any> {
  if (decisionModel) return decisionModel;
  if (decisionLoadPromise) return decisionLoadPromise;

  const loadStartedAt = performance.now();
  decisionLoadPromise = (async () => {
    // Fail-closed gate: never load a repo that is not allowlisted, and pin to
    // the registry revision (immutable SHA) so trust_remote_code cannot drift.
    const definition = resolveAiModel(modelId);
    if (definition.repo !== 'LiquidAI/d1-omni-600M') {
      throw new Error(`decision: model ${modelId} is not a d1-omni decision model`);
    }
    const { AutoModel, env } = (await import('@huggingface/transformers')) as any;
    if (env?.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }
    const model = await AutoModel.from_pretrained(definition.repo, {
      trust_remote_code: true,
      dtype: 'q8',
      revision: definition.revision,
    });
    decisionModel = model;
    console.log(
      `[flaxia-node] decision: model ready model=${definition.repo} revision=${definition.revision} loadMs=${Math.round(performance.now() - loadStartedAt)}`,
    );
    return model;
  })().catch((err) => {
    decisionLoadPromise = null;
    console.error(
      `[flaxia-node] decision: model load FAILED error=${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  });
  return decisionLoadPromise;
}

/**
 * Normalise a single d1-omni answer into the SDK `DecisionAnswer` shape.
 * The model's per-question payload is trusted as-is except for the generic
 * {type}-discriminated fields; probabilities are passed through verbatim.
 */
export function normalizeDecisionAnswer(raw: any): DecisionAnswer {
  const answer: DecisionAnswer = {};
  if (raw == null || typeof raw !== 'object') return answer;
  if (typeof raw.noul === 'number') answer.noul = raw.noul;
  if (typeof raw.choice === 'string') answer.choice = raw.choice;
  if (typeof raw.confidence === 'number') answer.confidence = raw.confidence;
  if (typeof raw.score === 'number') answer.score = raw.score;
  const probs = (raw.probabilities ?? raw.probs) as Record<string, number> | undefined;
  if (probs && typeof probs === 'object' && !Array.isArray(probs)) {
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(probs)) {
      if (typeof key === 'string' && typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    }
    if (Object.keys(clean).length > 0) answer.probabilities = clean;
  }
  if (Array.isArray(raw.levelProbabilities)) {
    const levels = raw.levelProbabilities.filter(
      (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v),
    ) as number[];
    if (levels.length > 0) answer.levelProbabilities = levels;
  }
  if (Array.isArray(raw.legend)) {
    const legend = raw.legend.filter((v: unknown): v is string => typeof v === 'string') as string[];
    if (legend.length > 0) answer.legend = legend;
  }
  return answer;
}

export async function handleDecision(payload: AiInferencePayload): Promise<AiInferenceResult> {
  const startTime = performance.now();
  if (payload.model !== DECISION_MODEL_ID) {
    throw new Error(`decision: model must be ${DECISION_MODEL_ID} for decision payloads, got ${JSON.stringify(payload.model)}`);
  }
  const { state, questions, imageUrls, audioUrl } = assertDecisionPayload(payload);
  const model = await loadDecisionModel(payload.model);

  // Fetch media as bytes; the model expects PIL images / int16|float samples.
  let images: any[] | undefined;
  if (imageUrls.length > 0) {
    const { loadImage } = (await import('@huggingface/transformers')) as any;
    images = [];
    for (const url of imageUrls) {
      const res = await fetchGuarded({
        url,
        allowContentTypes: ['image/*', 'application/octet-stream'],
        maxBytes: MAX_DECISION_IMAGE_BYTES,
        timeoutMs: DECISION_FETCH_TIMEOUT_MS,
      });
      if (!res.ok) throw new Error(`decision: image fetch failed (${res.status}): ${url}`);
      const blob = new Blob([res.bytes], { type: res.contentType || 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        const image = await loadImage(blobUrl);
        if (
          !Number.isSafeInteger(image.width) ||
          !Number.isSafeInteger(image.height) ||
          image.width < 1 ||
          image.height < 1 ||
          image.width * image.height > MAX_DECISION_IMAGE_PIXELS
        ) {
          throw new Error(
            `decision: image ${url} decodes to ${image.width}x${image.height}, above the ${MAX_DECISION_IMAGE_PIXELS} pixel limit`,
          );
        }
        images.push(image);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }
  let audio: Int16Array | Float32Array | undefined;
  if (audioUrl) {
    const res = await fetchGuarded({
      url: audioUrl,
      allowContentTypes: ['audio/*', 'application/octet-stream'],
      maxBytes: MAX_DECISION_AUDIO_BYTES,
      timeoutMs: DECISION_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`decision: audio fetch failed (${res.status}): ${audioUrl}`);
    // Decode to mono 16kHz in the browser: prefer OfflineAudioContext,
    // fall back to a raw PCM passthrough when the container lacks it.
    const arrayBuffer = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
    const AudioContextImpl =
      (globalThis as any).OfflineAudioContext ??
      (globalThis as any).webkitOfflineAudioContext;
    if (AudioContextImpl) {
      const ctx = new AudioContextImpl(1, DECISION_AUDIO_SAMPLE_RATE * DECISION_AUDIO_MAX_SECONDS, DECISION_AUDIO_SAMPLE_RATE);
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const ch0 = decoded.getChannelData(0);
      const n = Math.min(ch0.length, DECISION_AUDIO_MAX_SAMPLES);
      const samples = new Float32Array(n);
      samples.set(ch0.subarray(0, n));
      audio = samples;
    } else {
      // No WebAudio in this runtime: interpret the payload as raw 16-bit PCM
      // and truncate to the model's 30s window.
      const view = new Int16Array(arrayBuffer.slice(0));
      audio = view.subarray(0, Math.min(view.length, DECISION_AUDIO_MAX_SAMPLES));
    }
  }

  const result = model.system_one(state, questions, {
    images: images?.length ? images : undefined,
    audio,
  });
  const durationMs = Math.round(performance.now() - startTime);

  const answers: Record<string, DecisionAnswer> = {};
  const rawAnswers = (result as any)?.answers ?? {};
  for (const [name, raw] of Object.entries(rawAnswers)) {
    answers[name] = normalizeDecisionAnswer(raw);
  }
  const inputTokens =
    typeof (result as any)?.usage?.input_tokens === 'number'
      ? (result as any).usage.input_tokens
      : undefined;

  console.log(
    `[flaxia-node] decision: done questions=${Object.keys(answers).length} durationMs=${durationMs}`,
  );
  return { output: result, answers, inputTokens, durationMs };
}
