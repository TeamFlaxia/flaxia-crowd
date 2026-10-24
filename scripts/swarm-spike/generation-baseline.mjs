// Generation acceptance baseline for both browser and desktop nodes.
// Synthetic fixtures exercise protocol/engine plumbing only, not this baseline.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const GENERATION_BASELINE = Object.freeze({
  model: 'qwen3.5-2b',
  name: 'Qwen3.5-2B',
  quantization: 'Q4_0',
  modelUrl: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_0.gguf',
  bytes: 1214873856,
  sha256: 'cd70221bebaee0503e0f6717e174250cd7825aa88438b3aabec9ad55731d9bb1',
  prompt: 'What is the capital of France? Answer in one sentence.',
  maxNewTokens: 12,
});

/** Reject renamed synthetic models and different quantizations before GPU work. */
export async function verifyGenerationModel(file) {
  if ((await stat(file)).size !== GENERATION_BASELINE.bytes) {
    throw new Error(
      'Generation acceptance requires the real Qwen3.5-2B Q4_0 GGUF (wrong file size)',
    );
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== GENERATION_BASELINE.sha256) {
    throw new Error('Qwen3.5-2B Q4_0 model SHA-256 mismatch');
  }
  return GENERATION_BASELINE;
}
