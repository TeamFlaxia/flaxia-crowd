import type { DecisionAnswer, DecisionQuestion, DecisionQuestions } from '@flaxia/sdk';

/**
 * TypeScript port of d1-omni's `prompt.py` (LiquidAI/d1-omni-600M).
 *
 * One question is rendered over one state as:
 *
 *   <bos> <state> state <q> instructions <opt> <mask> option_0 </opt> ...
 *
 * The model scores the hidden state at every `<mask>` and softmaxes over the
 * question's options. Delimiters come from the tokenizer's reserved block and
 * `<|...|>` in caller text is rewritten so a state can never forge one.
 */

export const D1_QTYPES = { choice: 0, score: 1, noul: 2 } as const;

export const D1_DELIM = {
  state: '<|reserved_7|>',
  q: '<|reserved_8|>',
  opt: '<|reserved_9|>',
  optEnd: '<|reserved_10|>',
  decide: '<|reserved_11|>',
} as const;

export const D1_MARKER = '<|mask|>';

export const D1_YES_NO: Record<string, string> = { false: 'no', true: 'yes' };

const SPECIAL = /<\|([A-Za-z0-9_]+)\|>/g;

/** Token ids resolved once per tokenizer; every decode path needs all of them. */
export interface D1PromptTokens {
  state: number;
  q: number;
  opt: number;
  optEnd: number;
  decide: number;
  marker: number;
  bos: number;
}

export interface D1PromptTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
  convert_tokens_to_ids(token: string): number | number[];
  bos_token_id: number;
}

function idOf(tokenizer: D1PromptTokenizer, token: string): number {
  const id = tokenizer.convert_tokens_to_ids(token);
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error(`decision: tokenizer has no id for ${token}`);
  }
  return id;
}

/**
 * Resolve the reserved delimiters/marker once. Failing here (before any model
 * download) is the cheapest way to reject an incompatible tokenizer.
 */
export function resolvePromptTokens(tokenizer: D1PromptTokenizer): D1PromptTokens {
  const bos = tokenizer.bos_token_id;
  if (typeof bos !== 'number' || !Number.isFinite(bos)) {
    throw new Error('decision: tokenizer has no bos_token_id');
  }
  return {
    state: idOf(tokenizer, D1_DELIM.state),
    q: idOf(tokenizer, D1_DELIM.q),
    opt: idOf(tokenizer, D1_DELIM.opt),
    optEnd: idOf(tokenizer, D1_DELIM.optEnd),
    decide: idOf(tokenizer, D1_DELIM.decide),
    marker: idOf(tokenizer, D1_MARKER),
    bos,
  };
}

/** `<|name|>` -> `<¦name¦>`, so caller text cannot emit a delimiter or marker token. */
export function escapePromptText(text: string): string {
  return text.replace(SPECIAL, '<¦$1¦>');
}

export function serializeState(state: unknown): string {
  if (typeof state === 'string') return state;
  return JSON.stringify(state) ?? '';
}

function criterion(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

/** Option texts in the model's order. A noul is read as [false, true]. */
export function renderOptions(
  question: DecisionQuestion,
  noulDefault?: Record<string, string> | null,
  audio = false,
): string[] {
  if (question.type === 'choice') {
    const criteria = (question.criteria ?? {}) as Record<string, string>;
    return Object.entries(criteria).map(([key, description], index) =>
      audio
        ? `option_${String(index).padStart(3, '0')}: ${criterion(description || key)}`
        : description
          ? `${key}: ${criterion(description)}`
          : key,
    );
  }
  if (question.type === 'score') {
    const criteria = Array.isArray(question.criteria) ? question.criteria : [];
    return criteria.map((level, index) => `level ${index}: ${criterion(level)}`);
  }
  if (audio) return ['false: no', 'true: yes'];
  const criteria = (!Array.isArray(question.criteria) && question.criteria) || noulDefault || {};
  const no = criteria.false ?? criteria.no;
  const yes = criteria.true ?? criteria.yes;
  return [
    `false: ${no != null && no !== '' ? criterion(no) : 'no, the statement does not hold'}`,
    `true: ${yes != null && yes !== '' ? criterion(yes) : 'yes, the statement holds'}`,
  ];
}

export function questionTypes(question: DecisionQuestion): number {
  return D1_QTYPES[question.type];
}

export function questionOptions(question: DecisionQuestion): number {
  if (question.type === 'noul') return 2;
  if (question.type === 'score') {
    return Array.isArray(question.criteria) ? question.criteria.length : 0;
  }
  return question.criteria && !Array.isArray(question.criteria) ? Object.keys(question.criteria).length : 0;
}

export function temperatureKey(question: DecisionQuestion): string {
  const options = questionOptions(question);
  const bucket = options <= 2 ? '2' : options <= 5 ? '3-5' : options <= 10 ? '6-10' : '11+';
  return `${question.type}:${bucket}`;
}

/**
 * Port of `prompt.encode`: ids of one question over one state, and the position
 * of every option's marker. The option block gets max(96, min(24k+32, maxLen/2))
 * tokens, shared out evenly; the state is truncated on the right.
 */
export function encodePrompt(
  tokenizer: D1PromptTokenizer,
  tokens: D1PromptTokens,
  state: string,
  question: DecisionQuestion,
  maxLen: number,
  noulDefault?: Record<string, string> | null,
  audio = false,
  perOption = 24,
): { ids: number[]; markers: number[] } {
  const enc = (text: string): number[] => tokenizer.encode(escapePromptText(text), { add_special_tokens: false });
  const options = renderOptions(question, noulDefault, audio);
  if (options.length < 2) {
    throw new Error('decision: a question needs at least two options');
  }
  const budget = Math.max(96, Math.min(options.length * perOption + 32, Math.floor(maxLen / 2)));
  const per = Math.max(2, Math.floor((budget - 3 * options.length) / options.length));

  let rendered = [tokens.q, ...enc(question.instructions)].slice(0, Math.max(16, budget));
  const markers: number[] = [];
  for (const text of options) {
    markers.push(rendered.length + 1);
    rendered = rendered.concat(
      tokens.opt,
      tokens.marker,
      enc(` ${text}`).slice(0, per),
      tokens.optEnd,
    );
  }
  rendered.push(tokens.decide);

  const room = Math.max(0, maxLen - rendered.length - 2);
  const stateIds = [tokens.state, ...enc(serializeState(state)).slice(0, room)];
  const ids = [tokens.bos, ...stateIds, ...rendered].slice(0, maxLen);
  const shifted = markers.map((marker) => marker + 1 + stateIds.length);
  if (shifted[shifted.length - 1] >= maxLen) {
    throw new Error('decision: the options do not fit in the context');
  }
  return { ids, markers: shifted };
}

function softmax(values: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  let sum = 0;
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const exp = Math.exp(values[i] - max);
    out.push(exp);
    sum += exp;
  }
  return out.map((value) => value / sum);
}

/**
 * Port of `prompt.answer`: logits (option order) -> SDK answer. `calibrated`
 * applies the per-type temperature stored in the model config; image and audio
 * answers are the model's softmax as trained (same as prompt.py).
 */
export function answerQuestion(
  question: DecisionQuestion,
  logits: ArrayLike<number>,
  temperature = 1,
  calibrated = true,
): DecisionAnswer {
  const options = questionOptions(question);
  if (logits.length < options) {
    throw new Error(`decision: model returned ${logits.length} logits for ${options} options`);
  }
  const scaled: number[] = [];
  for (let i = 0; i < options; i++) {
    scaled.push(calibrated ? logits[i] / temperature : logits[i]);
  }
  let probabilities = softmax(scaled);
  if (question.type === 'noul') {
    // The model reads a noul as [false, true]; the SDK exposes P(yes).
    probabilities = probabilities.reverse();
    return { noul: probabilities[0] };
  }
  let best = 0;
  for (let i = 1; i < probabilities.length; i++) {
    if (probabilities[i] > probabilities[best]) best = i;
  }
  if (question.type === 'choice') {
    const names = Object.keys((question.criteria ?? {}) as Record<string, string>);
    const distribution: Record<string, number> = {};
    names.forEach((name, index) => {
      distribution[name] = probabilities[index] ?? 0;
    });
    return {
      choice: names[best],
      confidence: probabilities[best],
      probabilities: distribution,
    };
  }
  const legend = Array.isArray(question.criteria) ? question.criteria.map((level) => String(level)) : [];
  let expected = 0;
  probabilities.forEach((probability, index) => {
    expected += index * probability;
  });
  return {
    score: expected,
    confidence: probabilities[best],
    levelProbabilities: probabilities,
    legend,
  };
}

export function questionEntries(questions: DecisionQuestions): Array<[string, DecisionQuestion]> {
  return Object.entries(questions);
}

