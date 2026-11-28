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

function normalizePins(value: unknown): Map<string, AdapterPin> {
  const pins = new Map<string, AdapterPin>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return pins;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!EXPERT_ID.test(id) || !raw || typeof raw !== 'object') continue;
    const pin = raw as Record<string, unknown>;
    if (
      typeof pin.url === 'string' &&
      /^https:\/\//.test(pin.url) &&
      typeof pin.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(pin.sha256) &&
      typeof pin.maxBytes === 'number' &&
      Number.isSafeInteger(pin.maxBytes) &&
      pin.maxBytes > 0
    ) {
      pins.set(id, {
        url: pin.url,
        sha256: pin.sha256,
        maxBytes: pin.maxBytes,
        ...(typeof pin.revision === 'string' && /^[0-9a-f]{40}$/.test(pin.revision)
          ? { revision: pin.revision }
          : {}),
      });
    }
  }
  return pins;
}

let configuredPins: Map<string, AdapterPin> | null = null;

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
  try {
    return normalizePins(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

export function supportedTheiaExperts(): string[] {
  return [...adapterPins().keys()];
}

let model: DllmModel | null = null;
let modelLoad: Promise<DllmModel> | null = null;
let baseBytes: Uint8Array | null = null;
const expertModels = new Map<string, DllmModel>();
const expertLoads = new Map<string, Promise<DllmModel>>();
let generation = 0;

async function loadBase(): Promise<{ loaded: DllmModel; bytes: Uint8Array }> {
  if (model && baseBytes) return { loaded: model, bytes: baseBytes };
  if (modelLoad) {
    const loaded = await modelLoad;
    return { loaded, bytes: baseBytes! };
  }
  const pinnedGeneration = generation;
  modelLoad = (async () => {
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
  })().catch((error) => {
    modelLoad = null;
    throw error;
  });
  return { loaded: await modelLoad, bytes: baseBytes! };
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

  const pinnedGeneration = generation;
  const load = (async () => {
    const { bytes } = await loadBase();
    const adapter = await downloadPinnedModel(pin);
    const { Model } = await import('../../vendor/friedflaxia/friedflaxia_wasm.js');
    const loaded = (Model as unknown as {
      withLora: (base: Uint8Array, lora: Uint8Array) => DllmModel;
    }).withLora(bytes, adapter);
    if (loaded.loraExpert?.() !== expert || pinnedGeneration !== generation) {
      try {
        loaded.free();
      } catch {}
      throw new Error('theia-inference: stale expert load');
    }
    expertModels.set(expert, loaded);
    return loaded;
  })().catch((error) => {
    expertLoads.delete(expert);
    throw error;
  });
  expertLoads.set(expert, load);
  return load;
}

export const releaseCache = (): void => {
  generation += 1;
  for (const entry of expertModels.values()) {
    try {
      entry.free();
    } catch {}
  }
  expertModels.clear();
  expertLoads.clear();
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
