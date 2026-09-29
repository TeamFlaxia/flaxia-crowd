// Phase 1 validation: run the vendored Pooled engine on the REAL Qwen3.5-2B
// GGUF inside a dedicated module worker in headless Chrome, solo and split
// across two engines, and check the token streams match.
//
//   node scripts/swarm-spike/check-real-worker.mjs
//   CHROME=... MODEL=/path/model.gguf CHROME_GPU=swiftshader|real TOKENS=6 \
//     node scripts/swarm-spike/check-real-worker.mjs
//
// The GGUF is served from disk with Range support and every tensor is
// range-fetched — the same streaming loader the production runtime uses.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const MODEL = process.env.MODEL || '/tmp/opencode/swarm-real.gguf';
const GPU = process.env.CHROME_GPU || 'real';
const TOKENS = process.env.TOKENS || '6';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 900000);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(HERE, '../../vendor/pooled/engine');

if (!existsSync(MODEL)) {
  console.error(`model not found: ${MODEL} (run: npm run spike:swarm-real first, or set MODEL=)`);
  process.exit(1);
}

const WORKER_JS = `
import { Qwen35Engine } from '/engine/qwen35.js';
import { parseGGUFHeader, qwen35Weights, tokenizerFromGGUF, gpuUploadEntry, streamEntryToGPU, GGML_EMBED } from '/engine/gguf.js';
import { makeTokenizer, argmax } from '/engine/engine.js';

const MODEL = '/model.gguf';
const TOKENS = ${Number(TOKENS)};
const report = (m) => self.postMessage(m);
const fetchRange = async (lo, hi, name) => {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(MODEL, { headers: { Range: 'bytes=' + lo + '-' + hi } });
      if (r.status === 206) return r;
      last = new Error('status ' + r.status);
    } catch (e) { last = e; }
    await new Promise((res) => setTimeout(res, 150 * (attempt + 1)));
  }
  throw new Error('range fetch [' + lo + '-' + hi + ']' + (name ? ' (' + name + ')' : '') + ' failed: ' + (last && last.message));
};
const rangeFetch = async (lo, hi) => new Uint8Array(await (await fetchRange(lo, hi)).arrayBuffer());
const openRange = (info) => fetchRange(info.byteOffset, info.byteOffset + info.byteLength - 1, info.name);

try {
  report({ stage: 'header' });
  let size = 24 * 1024 * 1024, G;
  for (;;) {
    const b = await rangeFetch(0, size - 1);
    try { G = parseGGUFHeader(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); break; }
    catch (e) { if (size > 192 * 1024 * 1024) throw e; size *= 2; }
  }
  const bytesOf = async (i) => rangeFetch(i.byteOffset, i.byteOffset + i.byteLength - 1);
  const tok = makeTokenizer(tokenizerFromGGUF(G.meta));
  const V = tok.vocab;
  const L = G.meta['qwen35.block_count'] - (G.meta['qwen35.nextn_predict_layers'] || 0);
  report({ stage: 'meta', layers: L });

  if (!navigator.gpu) throw new Error('navigator.gpu is undefined in the worker');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter in the worker');
  const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
  const gpuErrors = [];
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(String(e.error?.message ?? e.error)));
  report({ stage: 'adapter', vendor: adapter.info?.vendor ?? null, architecture: adapter.info?.architecture ?? null });

  G.streamEntry = (info) => streamEntryToGPU(device, info, openRange, { staging: 4 * 1024 * 1024 });
  const eopts = { maxSeq: 1024, batchCols: 4, coopRowsB: 4, coopWG: 64 };
  const mk = async (lo, hi, head) => Qwen35Engine.create({
    device, meta: G.meta, layerRange: [lo, hi], hasEmbed: head, hasHead: head,
    vocab: G.tensors[GGML_EMBED].shape[0], ...eopts,
    weights: await qwen35Weights(G, bytesOf, { lo, hi, hasEmbed: head, hasHead: head, mtp: head && !!G.meta['qwen35.nextn_predict_layers'] },
      undefined, (e, name) => gpuUploadEntry(device, e, name === GGML_EMBED)),
  });

  const chat = (text) => [V['<|im_start|>'], ...tok.encode('user\\n' + text), V['<|im_end|>'], ...tok.encode('\\n'),
    V['<|im_start|>'], ...tok.encode('assistant\\n'), V['<think>'], ...tok.encode('\\n\\n'), V['</think>'], ...tok.encode('\\n\\n')];
  const eos = new Set([V['<|im_end|>'], V['<|endoftext|>']]);
  const prompt = ${process.env.CHAT_PROMPT
    ? `chat(${JSON.stringify(process.env.CHAT_PROMPT)})`
    : process.env.PROMPT
      ? `tok.encode(${JSON.stringify(process.env.PROMPT)})`
      : `chat('What is the capital of France? Answer in one sentence.')`};

  report({ stage: 'solo-load' });
  const solo = await mk(0, L, true);
  solo.reset();
  await solo.prefillTokens(prompt.slice(0, -1));
  let next = argmax(await solo.forwardToken(prompt[prompt.length - 1]));
  const soloTokens = [next];
  while (soloTokens.length < TOKENS && !eos.has(next)) { next = argmax(await solo.forwardToken(next)); soloTokens.push(next); }
  const soloText = tok.decode(soloTokens);

  report({ stage: 'split-load', soloText });
  const cut = Math.max(1, Math.floor(L / 2));
  const host = await mk(0, cut, true);
  const hop = await mk(cut, L, false);
  host.reset(); hop.reset();
  const chainOne = async (id, pos) => hop.runHidden(await host.embedRun(id, pos), pos);
  let logits = null, pos = 0;
  for (let i = 0; i < prompt.length; i++, pos++) {
    const h = await chainOne(prompt[i], pos);
    if (i === prompt.length - 1) logits = await host.headFromHidden(h);
  }
  let snext = argmax(logits);
  const splitTokens = [snext];
  while (splitTokens.length < TOKENS && !eos.has(snext)) { const h = await chainOne(snext, pos++); snext = argmax(await host.headFromHidden(h)); splitTokens.push(snext); }

  report({
    stage: 'engine', ok: gpuErrors.length === 0,
    soloText, splitText: tok.decode(splitTokens), soloIds: soloTokens, splitIds: splitTokens,
    same: soloTokens.join(',') === splitTokens.join(','), gpuErrors,
  });
} catch (err) {
  report({ stage: 'engine', ok: false, reason: String((err && err.message) || err) });
}
`;

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>real-worker-check</title>
<script>
  window.__result = null;
  window.__stages = [];
  try {
    const w = new Worker('/worker.js', { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      window.__stages.push(m.stage);
      if (m.stage === 'engine') window.__result = m;
    };
    w.onerror = (e) => { window.__result = { stage: 'engine', ok: false, reason: 'worker error: ' + (e.message || 'unknown') }; };
  } catch (err) {
    window.__result = { stage: 'engine', ok: false, reason: 'failed to construct worker: ' + err.message };
  }
</script>`;

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
}

function waitFor(check, { timeoutMs, intervalMs = 250, what }) {
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

const GPU_FLAGS = {
  real: ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  swiftshader: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'],
};

async function main() {
  const modelSize = statSync(MODEL).size;
  const web = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/worker.js') {
      res.setHeader('content-type', 'text/javascript; charset=utf-8');
      res.end(WORKER_JS);
      return;
    }
    if (url === '/model.gguf') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (match) {
        const start = Number(match[1]);
        const end = Math.min(match[2] ? Number(match[2]) : modelSize - 1, modelSize - 1);
        if (!(start <= end) || end >= modelSize) {
          console.error(`bad range ${start}-${end} (size ${modelSize})`);
          res.writeHead(416);
          res.end();
          return;
        }
        res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${modelSize}`, 'content-length': end - start + 1, connection: 'close' });
        const stream = createReadStream(MODEL, { start, end });
        stream.on('error', (e) => { console.error('read stream error:', e.message); try { res.destroy(); } catch {} });
        res.on('error', (e) => console.error('response error:', e.message));
        stream.pipe(res);
        return;
      }
      res.writeHead(200, { 'content-length': modelSize });
      createReadStream(MODEL).pipe(res);
      return;
    }
    if (url.startsWith('/engine/')) {
      const file = path.resolve(ENGINE_DIR, url.slice('/engine/'.length));
      if (!file.startsWith(ENGINE_DIR)) { res.statusCode = 403; res.end(); return; }
      try {
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(file));
      } catch { res.statusCode = 404; res.end(); }
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE_HTML);
  });
  const webPort = await listen(web);
  // SwiftShader loads slowly; a default 5s keep-alive would drop connections
  // between range requests mid-load and surface as "Failed to fetch".
  web.keepAliveTimeout = 0;
  web.headersTimeout = 0;
  web.on('clientError', () => {});

  const debugServer = http.createServer();
  const debugPort = await listen(debugServer);
  debugServer.close();

  const profile = mkdtempSync(path.join(tmpdir(), 'flaxia-real-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, ...(GPU_FLAGS[GPU] || GPU_FLAGS.real), 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { web.close(); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok, { timeoutMs: 15000, what: 'DevTools' });
    const targetResp = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${webPort}/`)}`, { method: 'PUT' });
    const target = await targetResp.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')), { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');

    const result = await waitFor(async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'window.__result', returnByValue: true });
      return r.result?.value ?? null;
    }, { timeoutMs: TIMEOUT_MS, what: 'worker result' });
    const stages = await cdp.send('Runtime.evaluate', { expression: 'window.__stages', returnByValue: true }).then((r) => r.result?.value).catch(() => []);

    console.log('stages:', JSON.stringify(stages));
    console.log('result:', JSON.stringify(result));
    if (!result.ok) {
      console.error('FAIL:', result.reason || result.gpuErrors);
      process.exitCode = 1;
    } else if (!result.same) {
      console.error('FAIL: split diverged from solo');
      process.exitCode = 1;
    } else {
      console.log(`PASS: real model ran in a worker; solo == split == ${JSON.stringify(result.soloText)}`);
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
