// Test-only local serving of the verified real Qwen3.5-2B GGUF. Production
// networking/registry code is unchanged; no synthetic weights are substituted.
import { createSwarmRuntime } from '../../node/src/swarm/runtime';
import * as engine from '../../node/src/swarm/engine-entry.js';
import { runHelper } from '../swarm/helper';
declare const Deno: any;
declare const FLAXIA_TEST_MODEL_FILE: string;
declare const FLAXIA_TEST_MODEL_URL: string;
// Test bytes must never be replaced by a persistent production weight cache.
Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true });
globalThis.fetch = async (input: any, options?: any) => {
  if (String(input) !== FLAXIA_TEST_MODEL_URL) throw new Error('unexpected test model URL');
  const range = /^bytes=(\d+)-(\d+)$/.exec(options?.headers?.Range ?? '');
  if (!range) throw new Error('expected bounded model range');
  const lo = Number(range[1]);
  const hi = Number(range[2]);
  const file = await Deno.open(FLAXIA_TEST_MODEL_FILE, { read: true });
  let remaining = hi - lo + 1;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      file.close();
    }
  };
  try {
    await file.seek(lo, 0);
  } catch (error) {
    close();
    throw error;
  }
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          if (remaining <= 0) {
            close();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(1024 * 1024, remaining));
          const read = await file.read(buffer);
          if (read === null) throw new Error('short model range');
          remaining -= read;
          controller.enqueue(buffer.subarray(0, read));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel() {
        close();
      },
    }),
    { status: 206 },
  );
};
await runHelper(createSwarmRuntime(async () => engine as any));
