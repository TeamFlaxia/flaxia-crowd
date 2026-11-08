/**
 * Node-side model registry for the `ai-inference` workload.
 *
 * A task payload's `model` field is unvalidated API input, and in
 * transformers.js it is both the repository id *and* the download source. Left
 * unchecked, any API key holder could make the whole volunteer fleet download
 * an arbitrary Hugging Face repository (bandwidth, storage, memory) or pin the
 * node to a revision of their choosing. Only models registered here are ever
 * loaded; an unknown id is rejected before any network request happens.
 *
 * Hosts extend the registry explicitly (and only at start-up) via
 * `registerAiModels`. The registry is process-wide: it is the node operator's
 * decision which repositories run on volunteers.
 */

export interface AiModelDefinition {
  /** Hugging Face repository id, e.g. `Xenova/bert-base-multilingual-uncased-sentiment`. */
  repo: string;
  /** Immutable revision (commit sha or tag) to pin the download to. */
  revision: string;
  /** Optional sha256 of the main weight file, for out-of-band integrity checks. */
  sha256?: string;
  /** Upper bound for a single model file download, in bytes. */
  maxBytes: number;
}

/** Default per-file download cap: 512 MiB. */
export const DEFAULT_AI_MODEL_MAX_BYTES = 512 * 1024 * 1024;
/** Hard ceiling for any registry entry: 4 GiB. */
export const MAX_AI_MODEL_MAX_BYTES = 4 * 1024 ** 3;

/**
 * Models a volunteer node is allowed to load out of the box. These are the
 * repositories this monorepo itself uses (see `packages/text-analyzer` and
 * `workloads/vector-embed.ts`), pinned to an immutable revision.
 */
const DEFAULT_AI_MODELS: Record<string, AiModelDefinition> = {
  'Xenova/bert-base-multilingual-uncased-sentiment': {
    repo: 'Xenova/bert-base-multilingual-uncased-sentiment',
    revision: 'main',
    maxBytes: DEFAULT_AI_MODEL_MAX_BYTES,
  },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    repo: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    revision: 'main',
    maxBytes: DEFAULT_AI_MODEL_MAX_BYTES,
  },
  // Decision model (LFM2.5-Encoder-350M based, 587M params). Runs via the
  // custom `decision` driver in workloads/decision.ts (trust_remote_code),
  // not the generic transformers.js pipeline path. `trust_remote_code`
  // executes Python code from the repo on the volunteer node, so the
  // revision is pinned to an immutable commit (not mutable `main`) to
  // prevent silent code changes from being loaded. Weights are ~2.4GB in
  // fp32, so the per-file cap is raised to 3GiB (hard ceiling 4GiB).
  'LiquidAI/d1-omni-600M': {
    repo: 'LiquidAI/d1-omni-600M',
    revision: '02b55d7076f15129e59ab3f94783f32c4b088674',
    maxBytes: 3 * 1024 ** 3,
  },
  // Multimodal embedding (740M params, 768 dims, Apache-2.0). The ONNX variant
  // is loaded by workloads/vector-embed.ts (multimodal) and
  // workloads/embed-gemma.ts (text-only, vision/audio disabled). Per-file cap
  // is 1 GiB to allow the fp16 audio/text encoders (~517-560 MB each) on WASM,
  // which the 512 MiB default would reject.
  'onnx-community/embeddinggemma-2-ONNX': {
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    revision: 'main',
    maxBytes: 1024 * 1024 * 1024,
  },
  // Light Inference translate model (M2M100, ONNX). Registered under its
  // canonical repo id so `resolveAiModel()` stays fail-closed; hosts may
  // alias it (e.g. 'm2m100-translate') via `registerAiModels` at startup.
  'Xenova/m2m100_418M': {
    repo: 'Xenova/m2m100_418M',
    revision: 'main',
    maxBytes: DEFAULT_AI_MODEL_MAX_BYTES,
  },
  // Flaxia's default translate model (PLaMO 3 Translate 0.8B, ONNX). The
  // q4f16 weights weigh ~673 MiB, above the 512 MiB default cap, and the
  // repo's fp16 weights reach ~1.7 GiB — so the entry raises the per-file
  // cap to 2 GiB (the 4 GiB hard ceiling still applies at the fetch guard).
  // Pinned to an immutable revision, matching Flaxia's PLAMO_MODEL_REVISION.
  'TeamFlaxia/plamo-3-translate-0.8b-onnx': {
    repo: 'TeamFlaxia/plamo-3-translate-0.8b-onnx',
    revision: '1c8417ee1a72442440ad515b02f99186c81fd08a',
    maxBytes: 2 * 1024 ** 3,
  },
};

const registry = new Map<string, AiModelDefinition>(
  Object.entries(DEFAULT_AI_MODELS).map(([id, definition]) => [id, { ...definition }]),
);

/** Execution devices a node is willing to run. `webgpu` is opt-in. */
export const ALLOWED_AI_DEVICES = ['wasm', 'cpu', 'webgpu'] as const;
export type AllowedAiDevice = (typeof ALLOWED_AI_DEVICES)[number];

/**
 * Quantization formats that keep a task inside the memory the node promised.
 * `fp32` and `fp16` are deliberately absent: a task could otherwise select the
 * largest possible weights for a model the node already accepted.
 */
export const ALLOWED_AI_DTYPES = ['q4', 'q4f16', 'q8', 'int8', 'uint8'] as const;
export type AllowedAiDtype = (typeof ALLOWED_AI_DTYPES)[number];

/** Generation options a payload may set, with their accepted ranges. */
const GENERATION_LIMITS: Record<string, { min: number; max: number }> = {
  max_new_tokens: { min: 1, max: 1024 },
  temperature: { min: 0, max: 4 },
  top_p: { min: 0, max: 1 },
  top_k: { min: 0, max: 1000 },
  repetition_penalty: { min: 0, max: 4 },
};

/** Maximum characters accepted for a single text input (and array length). */
export const MAX_AI_INPUT_CHARS = 100_000;
export const MAX_AI_INPUT_ITEMS = 64;

/**
 * Register (or replace) allowed models. Called by a host at start-up; entries
 * are validated here so a bad entry cannot widen the download limits.
 */
export function registerAiModels(definitions: Record<string, AiModelDefinition>): void {
  for (const [id, definition] of Object.entries(definitions)) {
    if (!id || typeof id !== 'string') throw new Error('ai model id must be a non-empty string');
    if (!definition || typeof definition.repo !== 'string' || !definition.repo) {
      throw new Error(`ai model ${id}: repo must be a non-empty string`);
    }
    if (typeof definition.revision !== 'string' || !definition.revision) {
      throw new Error(`ai model ${id}: revision must be a non-empty string (pin the download)`);
    }
    if (definition.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(definition.sha256)) {
      throw new Error(`ai model ${id}: sha256 must be a 64-character hex digest`);
    }
    const maxBytes = definition.maxBytes ?? DEFAULT_AI_MODEL_MAX_BYTES;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || maxBytes > MAX_AI_MODEL_MAX_BYTES) {
      throw new Error(`ai model ${id}: maxBytes must be within 1..${MAX_AI_MODEL_MAX_BYTES}`);
    }
    registry.set(id, { ...definition, maxBytes: Math.floor(maxBytes) });
  }
}

/** Remove a previously registered model (mostly useful for tests/hosts). */
export function unregisterAiModel(id: string): void {
  registry.delete(id);
}

/** All registered model ids, for diagnostics and operator tooling. */
export function listAiModels(): string[] {
  return [...registry.keys()];
}

/**
 * Resolve a payload's `model` to its registry entry, or throw a clear error.
 * This is the fail-closed gate: the returned `repo` is what gets passed to
 * transformers.js, never the raw payload value.
 */
export function resolveAiModel(model: unknown): AiModelDefinition {
  if (typeof model !== 'string' || !model) {
    throw new Error(`ai-inference: model must be a non-empty string, got ${JSON.stringify(model)}`);
  }
  const definition = registry.get(model);
  if (!definition) {
    throw new Error(
      `ai-inference: model not allowed: ${model} (allowed: ${listAiModels().join(', ') || 'none'})`,
    );
  }
  return definition;
}

/** Validate `options.device` against the node's allowlist. */
export function resolveAiDevice(device: unknown): AllowedAiDevice | undefined {
  if (device === undefined || device === null) return undefined;
  if (typeof device !== 'string' || !ALLOWED_AI_DEVICES.includes(device as AllowedAiDevice)) {
    throw new Error(
      `ai-inference: device not allowed: ${JSON.stringify(device)} (allowed: ${ALLOWED_AI_DEVICES.join(', ')})`,
    );
  }
  return device as AllowedAiDevice;
}

/** Validate `options.dtype` against the node's allowlist. */
export function resolveAiDtype(dtype: unknown): AllowedAiDtype | undefined {
  if (dtype === undefined || dtype === null) return undefined;
  if (typeof dtype !== 'string' || !ALLOWED_AI_DTYPES.includes(dtype as AllowedAiDtype)) {
    throw new Error(
      `ai-inference: dtype not allowed: ${JSON.stringify(dtype)} (allowed: ${ALLOWED_AI_DTYPES.join(', ')})`,
    );
  }
  return dtype as AllowedAiDtype;
}

/**
 * Validate `options.ondeviceOnly`. Absent = false (download on demand and
 * allow coordinator delegation). Anything but a boolean is rejected so the
 * flag cannot silently widen the download/delegation surface.
 */
export function resolveOndeviceOnly(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`ai-inference: option ondeviceOnly must be a boolean, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validate the task input: a bounded string or a bounded array of strings.
 * Anything else (objects, numbers, huge arrays) is rejected before the model
 * is loaded so a malformed payload cannot waste a download.
 */
export function assertAiInput(input: unknown): string | string[] {
  if (typeof input === 'string') {
    if (input.length > MAX_AI_INPUT_CHARS) {
      throw new Error(`ai-inference: input exceeds ${MAX_AI_INPUT_CHARS} characters`);
    }
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length === 0 || input.length > MAX_AI_INPUT_ITEMS) {
      throw new Error(`ai-inference: input array must hold 1..${MAX_AI_INPUT_ITEMS} items`);
    }
    for (const item of input) {
      if (typeof item !== 'string') {
        throw new Error('ai-inference: input array items must be strings');
      }
      if (item.length > MAX_AI_INPUT_CHARS) {
        throw new Error(`ai-inference: input exceeds ${MAX_AI_INPUT_CHARS} characters`);
      }
    }
    return input as string[];
  }
  throw new Error('ai-inference: input must be a string or an array of strings');
}

/**
 * Copy the numeric generation options into `target`, rejecting out-of-range or
 * non-numeric values instead of handing them to onnxruntime.
 */
export function applyGenerationOptions(
  target: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  for (const [key, range] of Object.entries(GENERATION_LIMITS)) {
    const value = options[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max) {
      throw new Error(
        `ai-inference: option ${key} must be a number within ${range.min}..${range.max}, got ${JSON.stringify(value)}`,
      );
    }
    target[key] = value;
  }
  if (options.do_sample !== undefined) {
    if (typeof options.do_sample !== 'boolean') {
      throw new Error('ai-inference: option do_sample must be a boolean');
    }
    target.do_sample = options.do_sample;
  }
  for (const key of ['src_lang', 'tgt_lang']) {
    const value = options[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !/^[a-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(value)) {
      throw new Error(`ai-inference: option ${key} must be a language code like 'en_XX'`);
    }
    target[key] = value;
  }
}