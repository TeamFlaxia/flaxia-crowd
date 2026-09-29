// Vite entry: bundles the vendored Pooled engine into a lazy chunk that the
// swarm runtime loads only when a swarm session starts. Kept as .js so the
// TypeScript build (which only includes src/**/*.ts) ignores it.
export { Qwen35Engine } from '../../../../vendor/pooled/engine/qwen35.js';
export {
  parseGGUFHeader,
  qwen35Weights,
  tokenizerFromGGUF,
  f32ToF16,
  f16ToF32,
  GGML_EMBED,
} from '../../../../vendor/pooled/engine/gguf.js';
export { makeTokenizer, argmax } from '../../../../vendor/pooled/engine/engine.js';
