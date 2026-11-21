import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = resolve(ROOT, 'packages/node/src/vendor/friedflaxia');
const manifest = JSON.parse(readFileSync(resolve(VENDOR_DIR, 'manifest.json'), 'utf8'));

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('vendored wasm files match the manifest hashes', () => {
  assert.match(manifest.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.target, 'web');
  assert.equal(manifest.wasmSimd128, true);
  assert.equal(manifest.wasmScalarFallback, true);
  for (const [name, expected] of Object.entries(manifest.files)) {
    assert.equal(sha256(resolve(VENDOR_DIR, name)), expected, `${name} drifted`);
  }
  const simd = sha256(resolve(VENDOR_DIR, 'friedflaxia_wasm_bg.wasm'));
  const scalar = sha256(resolve(VENDOR_DIR, 'friedflaxia_wasm_bg.scalar.wasm'));
  assert.notEqual(simd, scalar, 'the baseline fallback must not reuse the SIMD module');
});

test('shared model manifest is synced with the Rust source of truth', () => {
  const shared = JSON.parse(readFileSync(resolve(VENDOR_DIR, 'model-manifest.json'), 'utf8'));
  assert.equal(shared.preprocess.patchSize, 16);
  assert.equal(shared.preprocess.melBins, 128);
  assert.equal(shared.specialTokens.image, 258880);
  assert.match(shared.models.plamo.sha256, /^[0-9a-f]{64}$/);
  for (const [name, model] of Object.entries(shared.models)) {
    assert.match(model.url, /\/resolve\/[0-9a-f]{40}\//, `${name} must pin an immutable revision`);
    assert.match(model.sha256, /^[0-9a-f]{64}$/, `${name} must pin a SHA-256`);
  }
});

test('generated d.ts exposes the incremental generation API', () => {
  const declarations = readFileSync(resolve(VENDOR_DIR, 'friedflaxia_wasm.d.ts'), 'utf8');
  assert.match(declarations, /generate_stream\(/);
});

test('vendoring README records the same source commit', () => {
  const readme = readFileSync(resolve(VENDOR_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes(manifest.sourceCommit));
  assert.match(readme, /Do not edit the generated files/);
});
