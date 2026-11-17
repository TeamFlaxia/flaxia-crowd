import type {
  AiInferencePayload,
  AiInferenceResult,
  DecisionAnswer,
  DecisionQuestions,
} from '@flaxia/sdk';
import { resolveAiModel } from './ai-model-registry';
import { DECISION_ONNX_REPO, releaseCache as releaseEngine, runDecisionModel } from './d1-omni/engine';
import { fetchGuarded } from '../executor/egress-guard';

/**
 * Decision-model driver for d1-omni-600M (LiquidAI).
 *
 * The model runs through the split ONNX graphs from
 * `onnx-community/d1-omni-600M-ONNX` (see d1-omni/engine.ts): d1-omni is not a
 * Transformers.js pipeline task, so this module owns payload validation, media
 * fetching/decoding and the question batching, while the engine owns sessions,
 * prompt encoding and answer extraction.
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

export const releaseCache = (): void => {
  releaseEngine();
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

function assertDecisionModel(modelId: string): void {
  if (modelId !== DECISION_MODEL_ID) {
    throw new Error(`decision: model must be ${DECISION_MODEL_ID} for decision payloads, got ${JSON.stringify(modelId)}`);
  }
  // Fail-closed gate: the registry must still point at the ONNX conversion.
  const definition = resolveAiModel(modelId);
  if (definition.repo !== DECISION_ONNX_REPO) {
    throw new Error(`decision: model ${modelId} is not a ${DECISION_ONNX_REPO} entry`);
  }
}

async function fetchImages(imageUrls: string[]): Promise<unknown[] | undefined> {
  if (imageUrls.length === 0) return undefined;
  const { loadImage } = (await import('@huggingface/transformers')) as any;
  const images: unknown[] = [];
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
  return images;
}

async function fetchAudio(audioUrl?: string): Promise<Float32Array | Int16Array | undefined> {
  if (!audioUrl) return undefined;
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
    (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (AudioContextImpl) {
    const ctx = new AudioContextImpl(1, DECISION_AUDIO_SAMPLE_RATE * DECISION_AUDIO_MAX_SECONDS, DECISION_AUDIO_SAMPLE_RATE);
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const ch0 = decoded.getChannelData(0);
    const n = Math.min(ch0.length, DECISION_AUDIO_MAX_SAMPLES);
    const samples = new Float32Array(n);
    samples.set(ch0.subarray(0, n));
    return samples;
  }
  // No WebAudio in this runtime: interpret the payload as raw 16-bit PCM
  // and truncate to the model's 30s window.
  const view = new Int16Array(arrayBuffer.slice(0));
  return view.subarray(0, Math.min(view.length, DECISION_AUDIO_MAX_SAMPLES));
}

export async function handleDecision(payload: AiInferencePayload): Promise<AiInferenceResult> {
  const startTime = performance.now();
  assertDecisionModel(payload.model);
  const { state, questions, imageUrls, audioUrl } = assertDecisionPayload(payload);
  const [images, audio] = await Promise.all([fetchImages(imageUrls), fetchAudio(audioUrl)]);

  const { answers, inputTokens } = await runDecisionModel({ state, questions, images, audio });
  const durationMs = Math.round(performance.now() - startTime);

  const result = {
    answers: answers as Record<string, DecisionAnswer>,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };

  console.log(
    `[flaxia-node] decision: done questions=${Object.keys(answers).length} durationMs=${durationMs}`,
  );
  return { output: result, answers, inputTokens, durationMs };
}
