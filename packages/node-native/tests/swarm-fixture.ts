// CI-only, deterministic Qwen35 GGUF weights. Exercises actual native wgpu
// kernels and production range loader; never bundled into the production helper.
import bytes from '../dist/synth.gguf';
import { createSwarmRuntime } from '../../node/src/swarm/runtime';
import * as engine from '../../node/src/swarm/engine-entry.js';
import { runHelper } from '../swarm/helper';
const padded = new Uint8Array(Math.max(bytes.length, 12 * 1024 * 1024));
padded.set(bytes);
// Test bytes must never be replaced by a persistent production weight cache.
Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true });
globalThis.fetch = async (input: any, options?: any) => {
  if (
    String(input) !==
      'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_0.gguf'
  ) throw new Error('unexpected fixture model URL');
  const match = /^bytes=(\d+)-(\d+)$/.exec(options?.headers?.Range ?? '');
  if (!match) throw new Error('expected range request');
  return new Response(padded.slice(Number(match[1]), Number(match[2]) + 1), { status: 206 });
};
await runHelper(createSwarmRuntime(async () => engine as any));
