import type { DecisionQuestions } from '@flaxia/sdk';

/** Decision-model validation shared by the FriedFlaxia d1 backend. */

export const DECISION_MODEL_ID = 'LiquidAI/d1-omni-600M';

/** d1-omni audio contract: 16kHz mono, one clip per call. */
export const DECISION_AUDIO_SAMPLE_RATE = 16_000;
export const DECISION_AUDIO_MAX_SECONDS = 30;

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

export function assertDecisionPayload(payload: {
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

export function assertDecisionModelId(modelId: string): void {
  if (modelId !== DECISION_MODEL_ID) {
    throw new Error(`decision: model must be ${DECISION_MODEL_ID} for decision payloads, got ${JSON.stringify(modelId)}`);
  }
}
