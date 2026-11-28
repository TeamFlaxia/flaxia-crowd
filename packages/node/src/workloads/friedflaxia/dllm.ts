import type { NodeModelCacheSnapshot } from '@flaxia/sdk';
import { FRIEDFLAXIA_DLLM, downloadPinnedModel } from './model-registry';
import { initFriedFlaxiaWasm } from '../../vendor/friedflaxia/init';
import type { DllmModel } from '../../vendor/friedflaxia/types';

/**
 * Base masked-diffusion model used by `theia-inference`.
 *
 * Experts are LoRA adapters over this one base. Adapter pins are supplied by
 * `THEIA_LORA_ADAPTERS` (JSON: id -> {url, sha256, maxBytes, revision}) so a
 * self-built model can be distributed without rebuilding the vendored wasm.
 */

export const DLLM_MODEL_ID = FRIEDFLAXIA_DLLM.modelId;

interface AdapterPin {
  url: string;
  sha256: string;
  maxBytes: number;
  revision?: string;
}

const EXPERT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function rejectPin(id: string, reason: string): void {
  // Never log pin values (a URL can carry credentials); the id and reason are
  // enough to find the bad entry in THEIA_LORA_ADAPTERS.
  console.warn(`theia-inference: ignored THEIA_LORA_ADAPTERS pin '${id.slice(0, 64)}': ${reason}`);
}

function normalizePins(value: unknown): Map<string, AdapterPin> {
  const pins = new Map<string, AdapterPin>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined && value !== null) {
      console.warn('theia-inference: ignored THEIA_LORA_ADAPTERS: expected a JSON object of expert ids');
    }
    return pins;
  }
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!EXPERT_ID.test(id)) {
      rejectPin(id, 'invalid expert id (use lowercase letters, digits and hyphens)');
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejectPin(id, 'pin must be an object');
      continue;
    }
    const pin = raw as Record<string, unknown>;
    if (typeof pin.url !== 'string' || !/^https:\/\//.test(pin.url)) {
      rejectPin(id, 'url must be an https string');
      continue;
    }
    if (typeof pin.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
      rejectPin(id, 'sha256 must be 64 lowercase hex characters');
      continue;
    }
    if (typeof pin.maxBytes !== 'number' || !Number.isSafeInteger(pin.maxBytes) || pin.maxBytes <= 0) {
      rejectPin(id, 'maxBytes must be a positive safe integer');
      continue;
    }
    if (pin.revision !== undefined && !(typeof pin.revision === 'string' && /^[0-9a-f]{40}$/.test(pin.revision))) {
      console.warn(`theia-inference: THEIA_LORA_ADAPTERS pin '${id}' has an invalid revision; using 'adapter'`);
    }
    pins.set(id, {
      url: pin.url,
      sha256: pin.sha256,
      maxBytes: pin.maxBytes,
      ...(typeof pin.revision === 'string' && /^[0-9a-f]{40}$/.test(pin.revision)
        ? { revision: pin.revision }
        : {}),
    });
  }
  return pins;
}

let configuredPins: Map<string, AdapterPin> | null = null;
// Parse the environment once per value so a bad config is reported once, not
// on every heartbeat / model-cache snapshot.
let envPins: { raw: string; pins: Map<string, AdapterPin> } | null = null;

/** Browser hosts pass pins via NodeConfig; they have no `process.env`. */
export function setAdapterPins(pins: unknown): void {
  const normalized = normalizePins(pins);
  configuredPins = normalized.size > 0 ? normalized : null;
}

function adapterPins(): Map<string, AdapterPin> {
  if (configuredPins) return configuredPins;
  let raw: string | undefined;
  try {
    raw = process.env.THEIA_LORA_ADAPTERS;
  } catch {
    raw = undefined;
  }
  if (!raw) return new Map();
  if (envPins?.raw === raw) return envPins.pins;
  let pins: Map<string, AdapterPin>;
  try {
    pins = normalizePins(JSON.parse(raw));
  } catch {
    console.warn('theia-inference: ignored THEIA_LORA_ADAPTERS: invalid JSON');
    pins = new Map();
  }
  envPins = { raw, pins };
  return pins;
}

export function supportedTheiaExperts(): string[] {
  return [...adapterPins().keys()];
}

let model: DllmModel | null = null;
let modelLoad: Promise<DllmModel> | null = null;
let baseBytes: Uint8Array | null = null;
const expertModels = new Map<string, DllmModel>();
const expertLoads = new Map<string, Promise<DllmModel>>();
// The base is evicted only on an explicit full reset; experts are evicted on
// every release, so their in-flight loads need a separate invalidation signal.
let generation = 0;
let expertGeneration = 0;

async function loadBase(): Promise<{ loaded: DllmModel; bytes: Uint8Array }> {
  if (model && baseBytes) return { loaded: model, bytes: baseBytes };
  if (modelLoad) {
    const loaded = await modelLoad;
    return { loaded, bytes: baseBytes! };
  }
  const pinnedGeneration = generation;
  const pending = (async () => {
    await initFriedFlaxiaWasm();
    const bytes = await downloadPinnedModel(FRIEDFLAXIA_DLLM);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = new Model(bytes) as DllmModel;
    if (pinnedGeneration !== generation) {
      try {
        loaded.free();
      } catch {}
      throw new Error('friedflaxia: stale base load');
    }
    baseBytes = bytes;
    model = loaded;
    return loaded;
  })();
  modelLoad = pending;
  void pending.catch(() => {
    // Only clear the slot if a full reset has not already replaced this load.
    if (modelLoad === pending) modelLoad = null;
  });
  return { loaded: await pending, bytes: baseBytes! };
}

/** Load the base or a pinned LoRA expert. `expert` must be a configured id. */
export async function loadFriedFlaxiaDllm(expert?: string): Promise<DllmModel> {
  if (expert === undefined) return (await loadBase()).loaded;
  const cached = expertModels.get(expert);
  if (cached) return cached;
  const pending = expertLoads.get(expert);
  if (pending) return pending;

  const pin = adapterPins().get(expert);
  if (!pin) throw new Error(`theia-inference: no adapter pin for expert '${expert}'`);

  const pinnedExpertGeneration = expertGeneration;
  const load = (async () => {
    const { bytes } = await loadBase();
    const adapter = await downloadPinnedModel(pin);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = (Model as unknown as {
      withLora: (base: Uint8Array, lora: Uint8Array) => DllmModel;
    }).withLora(bytes, adapter);
    if (loaded.loraExpert?.() !== expert || pinnedExpertGeneration !== expertGeneration) {
      try {
        loaded.free();
      } catch {}
      throw new Error('theia-inference: stale expert load');
    }
    expertModels.set(expert, loaded);
    return loaded;
  })();
  expertLoads.set(expert, load);
  void load.catch(() => {
    // A release may have cleared and restarted the load for this expert.
    if (expertLoads.get(expert) === load) expertLoads.delete(expert);
  });
  return load;
}

/**
 * Evict resident experts. The 342 MB base is kept unless `includeBase` is
 * explicitly set, so an eviction cycle does not trigger a re-download.
 */
export const releaseCache = (options: { includeBase?: boolean } = {}): void => {
  expertGeneration += 1;
  for (const entry of expertModels.values()) {
    try {
      entry.free();
    } catch {}
  }
  expertModels.clear();
  expertLoads.clear();
  if (options.includeBase !== true) return;
  generation += 1;
  try {
    model?.free();
  } catch {}
  model = null;
  modelLoad = null;
  baseBytes = null;
};

export const isDllmLoaded = (): boolean => model !== null;
export const isDllmExpertLoaded = (expert: string): boolean => expertModels.has(expert);

/** Cache snapshot entries for the resident base and all resident experts. */
export function getDllmCacheSnapshot(): NodeModelCacheSnapshot {
  const sampledAt = Date.now();
  const entries: NodeModelCacheSnapshot['entries'] = [];
  if (isDllmLoaded()) {
    entries.push({
      modelId: DLLM_MODEL_ID,
      revision: (FRIEDFLAXIA_DLLM as { revision?: string }).revision ?? 'base',
      dtype: 'q4_0',
      backend: 'wasm',
      state: 'ready',
      referenceCount: 1,
    });
  }
  for (const expert of expertModels.keys()) {
    const pin = adapterPins().get(expert);
    entries.push({
      modelId: DLLM_MODEL_ID,
      revision: pin?.revision ?? 'adapter',
      dtype: 'q4_0',
      backend: 'wasm',
      state: 'ready',
      referenceCount: 1,
      adapterId: expert,
    });
  }
  return {
    version: 1,
    sampledAt,
    expiresAt: sampledAt + 60_000,
    entries: entries.slice(0, 8),
  };
}
