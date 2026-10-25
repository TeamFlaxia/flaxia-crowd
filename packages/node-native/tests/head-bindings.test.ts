// Real GPU readback regression for the row-sliced LM head. No large download.
import bytes from '../dist/synth.gguf';
import { Qwen35Engine } from '../../../vendor/pooled/engine/qwen35.js';
import { GGML_EMBED, parseGGUFHeader, qwen35Weights } from '../../../vendor/pooled/engine/gguf.js';
declare const Deno: any;
Deno.test('split LM-head bindings preserve every vocabulary logit', async () => {
  const adapter = await (navigator as any).gpu.requestAdapter();
  if (!adapter) throw new Error('GPU required for LM-head regression');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event: any) => errors.push(String(event.error)));
  const limits = new Proxy(device.limits, {
    get(target, key) {
      return key === 'maxStorageBufferBindingSize' ? 8192 : Reflect.get(target, key, target);
    },
  });
  const bounded = new Proxy(device, {
    get(target, key) {
      if (key === 'limits') return limits;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const create = async (gpu: any) => {
      const gguf = parseGGUFHeader(bytes.buffer);
      return Qwen35Engine.create({
        device: gpu,
        meta: gguf.meta,
        layerRange: [0, 4],
        hasEmbed: true,
        hasHead: true,
        vocab: gguf.tensors[GGML_EMBED].shape[0],
        maxSeq: 64,
        batchCols: 4,
        coopWG: 64,
        weights: await qwen35Weights(
          gguf,
          async (info: any) => bytes.slice(info.byteOffset, info.byteOffset + info.byteLength),
          { lo: 0, hi: 4, hasEmbed: true, hasHead: true },
        ),
      });
    };
    const whole = await create(device);
    const split = await create(bounded);
    if (!split.headOp.parts || split.headOp.parts.length < 2) {
      throw new Error('test must cross a head binding boundary');
    }
    const hidden = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i));
    const expected = await whole.headFromHidden(hidden);
    const actual = await split.headFromHidden(hidden);
    if (actual.length !== expected.length) throw new Error('vocabulary width changed');
    for (let i = 0; i < actual.length; i++) {
      if (!Number.isFinite(actual[i]) || actual[i] !== expected[i]) {
        throw new Error(`logit ${i} differs across the row boundary`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
  } finally {
    device.destroy();
  }
});
