import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GENERATION_BASELINE, verifyGenerationModel } from './generation-baseline.mjs';
import { PINNED_MODEL_URL } from './real-options.mjs';

test('web and desktop acceptance use the real Qwen3.5-2B Q4_0 baseline', () => {
  assert.equal(GENERATION_BASELINE.model, 'qwen3.5-2b');
  assert.equal(PINNED_MODEL_URL, GENERATION_BASELINE.modelUrl);
  assert.match(GENERATION_BASELINE.modelUrl, /Qwen3\.5-2B-Q4_0\.gguf$/);
  assert.match(GENERATION_BASELINE.sha256, /^[a-f0-9]{64}$/);
  assert.ok(GENERATION_BASELINE.bytes > 1024 ** 3);
});
test('a small model renamed Qwen3.5-2B cannot count as generation acceptance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crowd-generation-'));
  try {
    const file = path.join(directory, 'Qwen3.5-2B-Q4_0.gguf');
    await writeFile(file, 'GGUF synthetic');
    await assert.rejects(verifyGenerationModel(file), /real Qwen3.5-2B/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
