/**
 * Build-output guard for the browser bundle.
 *
 * Vite's library mode inlines every asset by default, which would base64 the
 * 2 MB wasm into the glue chunk and make every browser download both the SIMD
 * and baseline modules. The vendoring script adds `?no-inline`; this test
 * fails if a future Vite/config change undoes it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'packages/node/dist');

test('the built bundle emits both wasm modules as separate assets', () => {
  const simd = resolve(DIST, 'friedflaxia_wasm_bg.wasm');
  const scalar = resolve(DIST, 'friedflaxia_wasm_bg.scalar.wasm');
  assert.ok(existsSync(simd), 'missing SIMD wasm in dist');
  assert.ok(existsSync(scalar), 'missing baseline wasm in dist');

  const glue = readFileSync(resolve(DIST, 'assets/friedflaxia_wasm.js'), 'utf8');
  assert.ok(!glue.includes('data:application/wasm'), 'wasm was inlined into the glue chunk');
  assert.ok(glue.includes('../friedflaxia_wasm_bg.wasm'), 'glue does not use the emitted asset');

  const init = readFileSync(resolve(DIST, 'assets/init.js'), 'utf8');
  assert.ok(!init.includes('data:application/wasm'), 'baseline wasm was inlined into init.js');
  assert.ok(
    init.includes('../friedflaxia_wasm_bg.scalar.wasm'),
    'baseline fallback does not use the emitted asset',
  );
});

test('the SIMD artifact has vector instructions and the baseline does not', () => {
  const simd = readFileSync(resolve(DIST, 'friedflaxia_wasm_bg.wasm'));
  const scalar = readFileSync(resolve(DIST, 'friedflaxia_wasm_bg.scalar.wasm'));
  // f32x4.mul is the 0xFD-prefixed SIMD opcode 0xE6 (LEB: e6 01).
  assert.ok(simd.includes(Buffer.from([0xfd, 0xe6, 0x01])), 'SIMD artifact has no f32x4.mul');
  assert.ok(!scalar.includes(Buffer.from([0xfd, 0xe6, 0x01])), 'baseline artifact contains SIMD');
});
