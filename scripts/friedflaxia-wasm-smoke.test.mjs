/**
 * Cross-repo smoke test: instantiate the exact wasm artifacts that browsers
 * receive and check that their JS surface still matches the generated d.ts.
 * No model weights are needed, so this runs on every CI job.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = resolve(ROOT, 'packages/node/src/vendor/friedflaxia');
const GLUE = readFileSync(join(VENDOR_DIR, 'friedflaxia_wasm.js'));

async function instantiate(wasmName, cacheKey) {
  const tmp = mkdtempSync(join(tmpdir(), 'flaxia-friedflaxia-'));
  try {
    const gluePath = join(tmp, 'friedflaxia_wasm.mjs');
    writeFileSync(gluePath, GLUE);
    copyFileSync(join(VENDOR_DIR, wasmName), join(tmp, 'friedflaxia_wasm_bg.wasm'));

    const glue = await import(`${pathToFileURL(gluePath).href}?v=${cacheKey}`);
    glue.initSync(readFileSync(join(tmp, 'friedflaxia_wasm_bg.wasm')));

    for (const name of ['Model', 'MultimodalModel', 'D1MultimodalModel']) {
      assert.equal(typeof glue[name], 'function', `${wasmName}: ${name} export is missing`);
    }
    assert.equal(typeof glue.Model.prototype.generate, 'function');
    assert.equal(typeof glue.Model.prototype.generate_stream, 'function');
    assert.equal(typeof glue.Model.prototype.embed, 'function');
    // Theia's LoRA path loads an expert with `Model.withLora` and reads its
    // identity/rank from the loaded model, so a missing export breaks every
    // expert task even though the plain text paths still work.
    assert.equal(typeof glue.Model.withLora, 'function', `${wasmName}: Model.withLora is missing`);
    for (const name of ['denoise_topk', 'loraExpert', 'loraRank']) {
      assert.equal(
        typeof glue.Model.prototype[name],
        'function',
        `${wasmName}: Model.prototype.${name} is missing`,
      );
    }
    assert.equal(typeof glue.D1MultimodalModel.prototype.decision, 'function');
    return glue;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('SIMD wasm instantiates and exposes the expected API', async () => {
  await instantiate('friedflaxia_wasm_bg.wasm', 'simd');
});

test('baseline wasm instantiates with the same API', async () => {
  await instantiate('friedflaxia_wasm_bg.scalar.wasm', 'scalar');
});

test('the SIMD artifact contains vector instructions and the fallback does not', () => {
  const simd = readFileSync(join(VENDOR_DIR, 'friedflaxia_wasm_bg.wasm'));
  const scalar = readFileSync(join(VENDOR_DIR, 'friedflaxia_wasm_bg.scalar.wasm'));
  // f32x4.mul is the 0xFD-prefixed SIMD opcode 0xE6 (LEB: e6 01).
  assert.ok(simd.includes(Buffer.from([0xfd, 0xe6, 0x01])), 'SIMD artifact has no f32x4.mul');
  assert.ok(!scalar.includes(Buffer.from([0xfd, 0xe6, 0x01])), 'baseline artifact contains SIMD');
});
