#!/usr/bin/env node
/**
 * Browser smoke test for the shipped FriedFlaxia wasm split.
 *
 * Serves `packages/node/dist` and loads the real `init.js` chunk in Chrome.
 * The SIMD path must fetch `friedflaxia_wasm_bg.wasm`; a page whose
 * `WebAssembly.validate` rejects the SIMD probe must fetch the baseline
 * `friedflaxia_wasm_bg.scalar.wasm` instead.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const ROOT = resolve('packages/node/dist');
const PORT = 4174;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  try {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': MIME['.html'] });
      response.end(
        '<!doctype html><meta charset="utf-8"><script type="module">' +
          "import { initFriedFlaxiaWasm, hasWasmSimd } from '/wasm-init.js';" +
          'window.__wasmSmoke = { initFriedFlaxiaWasm, hasWasmSimd };' +
          '</script>',
      );
      return;
    }
    const name = path.replace(/^\/+/, '');
    if (!/^[a-z0-9._/-]+$/i.test(name) || name.includes('..')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await readFile(resolve(ROOT, name));
    response.writeHead(200, {
      'content-type': MIME[extname(name)] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((ready) => server.listen(PORT, '127.0.0.1', ready));
let browser;
try {
  const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await playwright.chromium.launch({
    executablePath: process.env.CHROME || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });

  async function run({ simd }) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('pageerror', (error) => console.error(`[page] ${error.message}`));
    if (!simd) {
      // The glue instantiates with compile/instantiate, not validate, so
      // rejecting every validate call only disables the SIMD feature probe.
      await page.addInitScript(() => {
        WebAssembly.validate = () => false;
      });
    }
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const result = await page.evaluate(async () => {
      const smoke = window.__wasmSmoke;
      await smoke.initFriedFlaxiaWasm();
      return { simd: smoke.hasWasmSimd() };
    });
    await context.close();
    const simdRequests = requests.filter((url) => url.endsWith('/friedflaxia_wasm_bg.wasm'));
    const scalarRequests = requests.filter((url) =>
      url.endsWith('/friedflaxia_wasm_bg.scalar.wasm'),
    );
    return { ...result, simdRequests, scalarRequests };
  }

  const vectorized = await run({ simd: true });
  console.log(`simd: ${JSON.stringify(vectorized)}`);
  if (!vectorized.simd) throw new Error('wasm smoke: Chrome did not detect SIMD');
  if (vectorized.simdRequests.length === 0) {
    throw new Error('wasm smoke: SIMD module was not fetched');
  }
  if (vectorized.scalarRequests.length !== 0) {
    throw new Error('wasm smoke: baseline module fetched for a SIMD browser');
  }

  const baseline = await run({ simd: false });
  console.log(`fallback: ${JSON.stringify(baseline)}`);
  if (baseline.simd) throw new Error('wasm smoke: SIMD probe was not rejected');
  if (baseline.scalarRequests.length === 0) {
    throw new Error('wasm smoke: baseline module was not fetched');
  }
  if (baseline.simdRequests.length !== 0) {
    throw new Error('wasm smoke: SIMD module fetched for a baseline browser');
  }
} finally {
  if (browser) await browser.close();
  await new Promise((closed) => server.close(closed));
}
