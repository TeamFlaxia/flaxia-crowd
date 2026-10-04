// Phase 0 check: can a dedicated Web Worker (the production runtime) obtain
// WebGPU *and* run the vendored Pooled engine slice end to end?
//
// The in-page flow and Chrome GPU flags follow Nehanth/pooled
// (https://github.com/Nehanth/pooled), MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
//
//   node scripts/swarm-spike/check-webgpu-worker.mjs
//   CHROME=/path/to/chrome node scripts/swarm-spike/check-webgpu-worker.mjs
//
// It serves a page, a module worker, the vendored `vendor/pooled/engine` files
// and a synthetic GGUF; drives headless Chrome over CDP; and reports:
//   stage "adapter": worker got an adapter + device
//   stage "engine":  worker created a Qwen35Engine slice and decoded tokens
// Exits non-zero if either stage fails.
//
// SECURITY: this harness launches Chrome with `--no-sandbox` and a DevTools
// (CDP) port bound to 127.0.0.1, then drives it. It may only ever load the
// pages this script itself serves on 127.0.0.1 — never a URL from an untrusted
// source — and `CHROME` must be an absolute path to a trusted, operator-
// installed browser binary (see trusted-chrome.mjs).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSynthGGUF } from '../../vendor/pooled/synth/synth.mjs';
import { resolveChromeBinary } from './trusted-chrome.mjs';

let CHROME;
try {
  CHROME = resolveChromeBinary();
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}
const TIMEOUT_MS = 90000;
const TOKENS = 12;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(HERE, '../../vendor/pooled/engine');

const WORKER_JS = `
import { Qwen35Engine } from '/engine/qwen35.js';
import { parseGGUFHeader, qwen35Weights, tokenizerFromGGUF, GGML_EMBED } from '/engine/gguf.js';
import { makeTokenizer, argmax } from '/engine/engine.js';

const report = (msg) => self.postMessage(msg);

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is undefined in the worker');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('requestAdapter() returned null in the worker');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  report({ stage: 'adapter', ok: true, vendor: adapter.info?.vendor ?? null, architecture: adapter.info?.architecture ?? null, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize });

  const gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error?.message ?? e.error)));

  const buf = await (await fetch('/synth.gguf')).arrayBuffer();
  const G = parseGGUFHeader(buf);
  const bytesOf = async (i) => new Uint8Array(buf, i.byteOffset, i.byteLength).slice();
  const tok = makeTokenizer(tokenizerFromGGUF(G.meta));
  const L = G.meta['qwen35.block_count'] - (G.meta['qwen35.nextn_predict_layers'] || 0);
  const engine = await Qwen35Engine.create({
    device, meta: G.meta, layerRange: [0, L], hasEmbed: true, hasHead: true,
    vocab: G.tensors[GGML_EMBED].shape[0], maxSeq: 256, batchCols: 4, coopRowsB: 4, coopWG: 64,
    weights: await qwen35Weights(G, bytesOf, { lo: 0, hi: L, hasEmbed: true, hasHead: true, mtp: true }),
  });
  engine.reset();
  const V = tok.vocab;
  const chat = (t) => [V['<|im_start|>'], ...tok.encode('user\\n' + t), V['<|im_end|>'], ...tok.encode('\\n'),
    V['<|im_start|>'], ...tok.encode('assistant\\n'), V['<think>'], ...tok.encode('\\n\\n'), V['</think>'], ...tok.encode('\\n\\n')];
  const prompt = chat('Write three sentences about the ocean.');
  await engine.prefillTokens(prompt.slice(0, -1));
  let next = argmax(await engine.forwardToken(prompt[prompt.length - 1]));
  const out = [next];
  while (out.length < ${TOKENS}) { next = argmax(await engine.forwardToken(next)); out.push(next); }
  report({ stage: 'engine', ok: gpuErrors.length === 0, tokens: out, text: tok.decode(out), gpuErrors });
} catch (err) {
  report({ stage: 'engine', ok: false, reason: String((err && err.message) || err) });
}
`;

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>webgpu-worker-check</title>
<script>
  window.__result = null;
  window.__adapter = null;
  try {
    const w = new Worker('/worker.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m && m.stage === 'adapter') window.__adapter = m;
      else window.__result = m;
    };
    w.onerror = (e) => { window.__result = { stage: 'engine', ok: false, reason: 'worker error: ' + (e.message || 'unknown') }; };
    w.postMessage('go');
  } catch (err) {
    window.__result = { stage: 'engine', ok: false, reason: 'failed to construct worker: ' + err.message };
  }
</script>`;

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(check, { timeoutMs, intervalMs = 150, what }) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await check();
        if (value !== null && value !== undefined) return resolve(value);
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function main() {
  const { bytes } = buildSynthGGUF({});
  const synth = Buffer.from(bytes);

  const web = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(WORKER_JS);
      return;
    }
    if (url === '/synth.gguf') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(synth);
      return;
    }
    if (url.startsWith('/engine/')) {
      const file = path.resolve(ENGINE_DIR, url.slice('/engine/'.length));
      if (!file.startsWith(ENGINE_DIR)) { res.statusCode = 403; res.end(); return; }
      try {
        const body = readFileSync(file);
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
  });
  const webPort = await listen(web);

  // DevTools stays bound to 127.0.0.1: `listen()` never accepts an external
  // interface, so the CDP port is not reachable from the network.
  const debugServer = http.createServer();
  const debugPort = await listen(debugServer);
  debugServer.close();

  const profile = mkdtempSync(path.join(tmpdir(), 'flaxia-webgpu-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--enable-unsafe-webgpu',
      '--use-webgpu-adapter=swiftshader',
      '--enable-features=Vulkan',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeErr = '';
  chrome.stderr.on('data', (d) => {
    chromeErr += d.toString();
  });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { web.close(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok, {
      timeoutMs: 15000,
      what: 'Chrome DevTools endpoint',
    });

    const targetResp = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${webPort}/`)}`,
      { method: 'PUT' },
    );
    if (!targetResp.ok) throw new Error(`/json/new failed: HTTP ${targetResp.status}`);
    const target = await targetResp.json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');

    const result = await waitFor(
      async () => {
        const r = await cdp.send('Runtime.evaluate', { expression: 'window.__result', returnByValue: true });
        return r.result?.value ?? null;
      },
      { timeoutMs: TIMEOUT_MS, what: 'worker engine result' },
    );

    const adapter = await cdp
      .send('Runtime.evaluate', { expression: 'window.__adapter', returnByValue: true })
      .then((r) => r.result?.value ?? null)
      .catch(() => null);

    console.log('worker adapter:', JSON.stringify(adapter));
    console.log('worker result:', JSON.stringify(result));
    if (!result.ok) {
      console.error('FAIL: worker could not run the engine:', result.reason || result.gpuErrors);
      process.exitCode = 1;
    } else {
      console.log(
        `PASS: worker obtained WebGPU (${result.tokens.length} tokens) and ran the Pooled engine slice; text=${JSON.stringify(result.text)}`,
      );
    }
    ws.close();
  } catch (err) {
    console.error('FAIL:', err.message);
    if (chromeErr.trim()) console.error('chrome stderr tail:\n' + chromeErr.split('\n').slice(-8).join('\n'));
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

await main();
