import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the env objects the workload modules configure so we can assert they
// force single-threaded wasm (the fix for the mobile worker-swarm / crash).
// vi.hoisted lifts these above the hoisted vi.mock factory calls.
const { transformersEnv, ortEnv } = vi.hoisted(() => ({
  transformersEnv: { backends: { onnx: { wasm: {} as Record<string, unknown> } } },
  ortEnv: { wasm: {} as Record<string, unknown> },
}));

vi.mock('@huggingface/transformers', () => ({
  env: transformersEnv,
  pipeline: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue({ data: new Float32Array(1024) })),
  TextStreamer: class {},
}));

vi.mock('onnxruntime-web', () => ({
  env: ortEnv,
  InferenceSession: { create: vi.fn().mockResolvedValue({}) },
  Tensor: class {},
}));

// Importing ai-inference runs its top-level single-thread configuration.
import '../ai-inference';
import { configureOrt } from '../nudenet';
import { handleVectorEmbed } from '../vector-embed';

describe('wasm single-threaded configuration (mobile crash fix)', () => {
  it('forces onnxruntime-web (nudenet) to single-threaded wasm', () => {
    configureOrt();
    expect(ortEnv.wasm.numThreads).toBe(1);
    expect(ortEnv.wasm.proxy).toBe(false);
  });

  it('forces transformers.js (ai-inference) to single-threaded wasm', () => {
    expect(transformersEnv.backends.onnx.wasm.numThreads).toBe(1);
    expect(transformersEnv.backends.onnx.wasm.proxy).toBe(false);
  });

  it('forces transformers.js (vector-embed) to single-threaded wasm', async () => {
    await handleVectorEmbed({ text: 'hello' } as any);
    expect(transformersEnv.backends.onnx.wasm.numThreads).toBe(1);
    expect(transformersEnv.backends.onnx.wasm.proxy).toBe(false);
  });
});
