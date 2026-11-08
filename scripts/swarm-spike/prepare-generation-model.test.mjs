import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareGenerationModel } from './prepare-generation-model.mjs';

test('an incomplete download is rejected and never becomes a cached model', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crowd-download-'));
  try {
    const model = path.join(directory, 'model.gguf');
    await assert.rejects(
      prepareGenerationModel(model, async () => new Response('short model')),
      /wrong file size/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a corrupt cache hit fails before making a network request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crowd-download-'));
  try {
    const model = path.join(directory, 'model.gguf');
    await writeFile(model, 'not real weights');
    let downloaded = false;
    await assert.rejects(
      prepareGenerationModel(model, async () => {
        downloaded = true;
        throw new Error('must not fetch');
      }),
      /wrong file size/,
    );
    assert.equal(downloaded, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
