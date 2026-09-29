import {
  buildSwarmChain,
  type SwarmChainNode,
  type SwarmMember,
  type SwarmSlice,
} from '@flaxia/sdk';
import {
  loadPooledEngineModule,
  wrapPooledEngine,
  SwarmEngineUnavailableError,
  type PooledEngineModule,
  type PooledGguf,
  type PooledTensorInfo,
  type PooledTokenizer,
} from './adapter';
import type { SwarmRuntime } from './controller';
import { SESSION_MAX_SEQ, type SwarmSemantics } from './session';

/**
 * Production model access for swarm slices.
 *
 * The host fetches only the GGUF header to learn the layer count, then plans the
 * split. Every node range-fetches (and caches) just its own layer byte spans and
 * creates an engine slice on its own GPU. The vendored Pooled engine is loaded
 * lazily from the `swarm-engine.js` chunk so a node that never serves a swarm
 * task never downloads it.
 */

/** GGUF sources for the models the swarm engine can split. */
const SWARM_GGUF_URLS: Record<string, string> = {
  // Qwen3.5 / 3.8 are Gated-DeltaNet hybrids ("qwen35" in GGUF), handled by
  // Qwen35Engine — not DenseEngine.
  'qwen3.5-2b':
    'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_0.gguf',
  'qwen3.8-27b':
    'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_0.gguf',
  'qwen3.6-35b-moe':
    'https://huggingface.co/bartowski/Qwen_Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen_Qwen3.6-35B-A3B-Q4_0.gguf',
};

const CACHE_NAME = 'flaxia-swarm-weights-v1';
const HEADER_START_BYTES = 12 * 1024 * 1024;
const HEADER_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Resolve a task payload's `model` to the GGUF it loads.
 *
 * The payload is unvalidated API input: it must only ever match the registry
 * above, never a caller-supplied URL, or every opted-in node could be made to
 * range-fetch an arbitrary host of the submitter's choosing.
 */
export function resolveModelUrl(model: string): string {
  const url = SWARM_GGUF_URLS[model];
  if (url) return url;
  throw new SwarmEngineUnavailableError(`unknown swarm model: ${model}`);
}

let weightCache: Cache | false | null = null;

// Range-fetch accounting for `load()`, so a node can report whether its slice
// came out of the weight cache. A node runs one swarm session at a time (the
// worker pool serialises tasks), so these module-level counters never overlap.
let rangeCacheHits = 0;
let rangeCacheMisses = 0;
async function getWeightCache(): Promise<Cache | false> {
  if (weightCache !== null) return weightCache;
  try {
    weightCache = typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : false;
  } catch {
    weightCache = false;
  }
  return weightCache;
}

function cacheKey(url: string, lo: number, hi: number): string {
  return `https://flaxia-weights.local/${encodeURIComponent(url)}/${lo}-${hi}`;
}

/** Range-fetch bytes, caching complete entries so a second start skips the network. */
export async function rangeFetch(url: string, lo: number, hi: number): Promise<Uint8Array> {
  const response = await rangeFetchResponse(url, lo, hi);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const length = hi - lo + 1;
  if (bytes.byteLength !== length) throw new Error(`short range ${bytes.byteLength}/${length}`);
  return bytes;
}

/**
 * Range-fetch a tensor as a streaming Response (for GPU-side streaming loads).
 * Retries transient network failures, which matter on long mobile loads.
 */
async function rangeFetchResponse(url: string, lo: number, hi: number): Promise<Response> {
  const length = hi - lo + 1;
  const cache = await getWeightCache();
  const key = cacheKey(url, lo, hi);

  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if (bytes.byteLength === length) {
          rangeCacheHits++;
          return new Response(bytes, { status: 200 });
        }
        await cache.delete(key).catch(() => {});
      }
    } catch {}
  }

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${lo}-${hi}` } });
      if (response.status !== 206) {
        last = new Error(`model host refused range requests (${response.status})`);
      } else {
        rangeCacheMisses++;
        if (cache) {
          response
            .clone()
            .arrayBuffer()
            .then((buffer) => {
              if (buffer.byteLength !== length) return;
              return cache.put(
                key,
                new Response(buffer, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
              );
            })
            .catch(() => {});
        }
        return response;
      }
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw new Error(`range fetch ${lo}-${hi} failed: ${last instanceof Error ? last.message : String(last)}`);
}

/** Fetch as much of the file as it takes to parse the GGUF header + tokenizer. */
async function fetchGGUFHeader(mod: PooledEngineModule, url: string): Promise<PooledGguf> {
  let size = HEADER_START_BYTES;
  for (;;) {
    const bytes = await rangeFetch(url, 0, size - 1);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    try {
      return mod.parseGGUFHeader(buffer);
    } catch (err) {
      if (size >= HEADER_MAX_BYTES) throw err;
      size = Math.min(size * 2, HEADER_MAX_BYTES);
    }
  }
}

async function requestDevice(): Promise<unknown> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<any> } }).gpu;
  if (!gpu) throw new SwarmEngineUnavailableError('WebGPU is not available in this context');
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new SwarmEngineUnavailableError('no WebGPU adapter');
  return adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
}

export function buildSemantics(mod: PooledEngineModule, tok: PooledTokenizer): SwarmSemantics {
  const vocab = tok.vocab;
  const imStart = vocab['<|im_start|>'];
  const imEnd = vocab['<|im_end|>'];
  // The GGUF special tokens are "<think>" / "</think>" (no leading space).
  const thinkOpen = vocab['<think>'];
  const thinkClose = vocab['</think>'];

  const chat = (text: string): number[] =>
    [
      imStart,
      ...tok.encode('user\n' + text),
      imEnd,
      ...tok.encode('\n'),
      imStart,
      ...tok.encode('assistant\n'),
      thinkOpen,
      ...tok.encode('\n\n'),
      thinkClose,
      ...tok.encode('\n\n'),
    ].filter((id): id is number => typeof id === 'number' && id >= 0);

  const eos = [imEnd, vocab['<|endoftext|>']].filter((id): id is number => typeof id === 'number');

  return {
    packHidden: (hidden) => {
      const u16 = new Uint16Array(hidden.length);
      for (let i = 0; i < hidden.length; i++) u16[i] = mod.f32ToF16(hidden[i]);
      return new Uint8Array(u16.buffer);
    },
    unpackHidden: (payload) => {
      const copy = payload.slice();
      const u16 = new Uint16Array(copy.buffer);
      const hidden = new Float32Array(u16.length);
      for (let i = 0; i < u16.length; i++) hidden[i] = mod.f16ToF32(u16[i]);
      return hidden;
    },
    argmax: (logits) => mod.argmax(logits),
    encodePrompt: (text) => chat(Array.isArray(text) ? text.join('\n') : text),
    decodeTokens: (ids) => tok.decode(ids),
    eosIds: new Set(eos),
  };
}

export function createSwarmRuntime(): SwarmRuntime {
  let modulePromise: Promise<PooledEngineModule> | null = null;
  let cached: { url: string; gguf: PooledGguf } | null = null;

  const getModule = (): Promise<PooledEngineModule> => {
    if (!modulePromise) {
      const url = new URL('./swarm-engine.js', import.meta.url).href;
      modulePromise = loadPooledEngineModule(url).then((mod) => mod as PooledEngineModule);
    }
    return modulePromise;
  };

  const resolve = async (model: string) => {
    const mod = await getModule();
    const url = resolveModelUrl(model);
    if (!cached || cached.url !== url) {
      cached = { url, gguf: await fetchGGUFHeader(mod, url) };
    }
    const layers =
      Number(cached.gguf.meta['qwen35.block_count']) -
      Number(cached.gguf.meta['qwen35.nextn_predict_layers'] || 0);
    if (!Number.isInteger(layers) || layers < 1) {
      throw new SwarmEngineUnavailableError(`model ${model} has no qwen35 trunk layers`);
    }
    return { mod, url, gguf: cached.gguf, layers };
  };

  return {
    async plan(members: SwarmMember[], model: string): Promise<SwarmChainNode[]> {
      const { layers } = await resolve(model);
      return buildSwarmChain({
        sessionId: '',
        taskId: '',
        model,
        layers,
        nodes: members.map((m) => ({ nodeId: m.nodeId, capacity: m.capacity })),
      }).chain;
    },

    async load(slice: SwarmSlice, model: string) {
      rangeCacheHits = 0;
      rangeCacheMisses = 0;
      const { mod, url, gguf } = await resolve(model);

      const device = await requestDevice();
      const tokenizer = mod.makeTokenizer(mod.tokenizerFromGGUF(gguf.meta));
      const bytesOf = (info: PooledTensorInfo) =>
        rangeFetch(url, info.byteOffset, info.byteOffset + info.byteLength - 1);

      // Large Q4_0/Q8_0 matrices are streamed straight into GPU buffers, and the
      // rest are uploaded with writeBuffer: a mappedAtCreation copy of the ~254 MB
      // tied embedding is what a naive load cannot allocate.
      gguf.streamEntry = (info) =>
        mod.streamEntryToGPU(
          device,
          info,
          (i) => rangeFetchResponse(url, i.byteOffset, i.byteOffset + i.byteLength - 1),
          { staging: 4 * 1024 * 1024 },
        );
      const weights = await mod.qwen35Weights(
        gguf,
        bytesOf,
        {
          lo: slice.start,
          hi: slice.end,
          hasEmbed: slice.hasEmbed,
          hasHead: slice.hasHead,
          mtp: slice.hasHead,
        },
        undefined,
        // Keep the embedding on the CPU: the host does per-token row lookups.
        (entry, name) => mod.gpuUploadEntry(device, entry, name === mod.GGML_EMBED),
      );

      const vocabSize = gguf.tensors[mod.GGML_EMBED]?.shape[0] ?? 0;
      const engine = await mod.Qwen35Engine.create({
        device,
        meta: gguf.meta,
        layerRange: [slice.start, slice.end],
        hasEmbed: slice.hasEmbed,
        hasHead: slice.hasHead,
        vocab: vocabSize,
        maxSeq: Math.min(SESSION_MAX_SEQ, Number(gguf.meta['qwen35.context_length']) || SESSION_MAX_SEQ),
        batchCols: 4,
        weights,
      });

      const warm = rangeCacheHits > 0 && rangeCacheMisses === 0;
      return { engine: wrapPooledEngine(engine, device), semantics: buildSemantics(mod, tokenizer), warm };
    },
  };
}
