// Phase 0/1 validation: run the vendored Pooled engine on a REAL GGUF over
// WebGPU (Deno), solo and split across two engines, and compare token streams.
//
//   deno run --unstable-webgpu --allow-read --allow-write --allow-net \
//     scripts/swarm-spike/run-real.mjs --tokens 12
//
// The GGUF is served from a local HTTP server with Range support, and every
// tensor is range-fetched — the same streaming loader path the production
// runtime uses (nothing tensor-sized is ever held in JS).
import http from "node:http";
import fs from "node:fs";
import { Qwen35Engine } from "../../vendor/pooled/engine/qwen35.js";
import {
  parseGGUFHeader,
  qwen35Weights,
  tokenizerFromGGUF,
  gpuUploadEntry,
  streamEntryToGPU,
  GGML_EMBED,
} from "../../vendor/pooled/engine/gguf.js";
import { makeTokenizer, argmax } from "../../vendor/pooled/engine/engine.js";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? argv[i + 1] : d;
};
const URL_ =
  arg("url", "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_0.gguf");
const TOKENS = +arg("tokens", 12);
const CACHE = arg("cache", "/tmp/opencode/swarm-real.gguf");

function fail(msg) {
  console.error("REAL SPIKE FAIL:", msg);
  process.exit(1);
}

async function ensureModel() {
  if (fs.existsSync(CACHE)) return;
  const t0 = performance.now();
  console.log("downloading", URL_);
  const response = await fetch(URL_);
  if (!response.ok) fail(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  fs.writeFileSync(CACHE, bytes);
  console.log(`model ${(bytes.length / 2 ** 20).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

/** Local HTTP server with Range support so loads stream from disk, not RAM. */
function serveFile(file) {
  const size = fs.statSync(file).size;
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
      res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-length": size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, urlBase: `http://127.0.0.1:${server.address().port}/model.gguf` })));
}

async function main() {
  await ensureModel();
  const { server, urlBase } = await serveFile(CACHE);

  const rangeFetch = async (lo, hi) => {
    const r = await fetch(urlBase, { headers: { Range: `bytes=${lo}-${hi}` } });
    if (r.status !== 206) throw new Error(`range fetch failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const openRange = (info) => fetch(urlBase, { headers: { Range: `bytes=${info.byteOffset}-${info.byteOffset + info.byteLength - 1}` } });

  let headerSize = 24 * 1024 * 1024;
  let G, headBytes;
  for (;;) {
    headBytes = await rangeFetch(0, headerSize - 1);
    try { G = parseGGUFHeader(headBytes.buffer.slice(headBytes.byteOffset, headBytes.byteOffset + headBytes.byteLength)); break; }
    catch (e) { if (headerSize > 192 * 1024 * 1024) throw e; headerSize *= 2; }
  }
  const bytesOf = async (i) => rangeFetch(i.byteOffset, i.byteOffset + i.byteLength - 1);
  const tok = makeTokenizer(tokenizerFromGGUF(G.meta));
  const V = tok.vocab;
  const L = G.meta["qwen35.block_count"] - (G.meta["qwen35.nextn_predict_layers"] || 0);
  console.log(`arch=${G.meta["general.architecture"]} layers=${L} dim=${G.meta["qwen35.embedding_length"]} vocab=${G.meta["tokenizer.ggml.tokens"].length} mtp=${!!G.meta["qwen35.nextn_predict_layers"]}`);

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) fail("no WebGPU adapter (run with --unstable-webgpu)");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  const gpuErrors = [];
  device.addEventListener("uncapturederror", (e) => gpuErrors.push(String(e.error?.message ?? e.error)));

  G.streamEntry = (info) => streamEntryToGPU(device, info, openRange, { staging: 4 * 1024 * 1024 });
  const eopts = { maxSeq: 1024, batchCols: 4, coopRowsB: 4, coopWG: 64 };
  const mk = async (lo, hi, head) =>
    Qwen35Engine.create({
      device, meta: G.meta, layerRange: [lo, hi], hasEmbed: head, hasHead: head,
      vocab: G.tensors[GGML_EMBED].shape[0], ...eopts,
      weights: await qwen35Weights(
        G, bytesOf, { lo, hi, hasEmbed: head, hasHead: head, mtp: head && !!G.meta["qwen35.nextn_predict_layers"] },
        undefined, (e, name) => gpuUploadEntry(device, e, name === GGML_EMBED),
      ),
    });

  const chat = (text) => [
    V["<|im_start|>"], ...tok.encode("user\n" + text), V["<|im_end|>"], ...tok.encode("\n"),
    V["<|im_start|>"], ...tok.encode("assistant\n"),
    V["<think>"], ...tok.encode("\n\n"), V["</think>"], ...tok.encode("\n\n"),
  ];
  const eos = new Set([V["<|im_end|>"], V["<|endoftext|>"]]);
  const prompt = chat("What is the capital of France? Answer in one sentence.");

  const t1 = performance.now();
  const solo = await mk(0, L, true);
  solo.reset();
  await solo.prefillTokens(prompt.slice(0, -1));
  let next = argmax(await solo.forwardToken(prompt[prompt.length - 1]));
  const soloTokens = [next];
  while (soloTokens.length < TOKENS && !eos.has(next)) { next = argmax(await solo.forwardToken(next)); soloTokens.push(next); }
  console.log(`solo (${((performance.now() - t1) / 1000).toFixed(1)}s): ${JSON.stringify(tok.decode(soloTokens).slice(0, 160))}`);

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
  while (splitTokens.length < TOKENS && !eos.has(snext)) {
    const h = await chainOne(snext, pos++);
    snext = argmax(await host.headFromHidden(h));
    splitTokens.push(snext);
  }
  const same = soloTokens.join(",") === splitTokens.join(",");
  console.log(`split ${cut}-${L - 1}: ${JSON.stringify(tok.decode(splitTokens).slice(0, 160))}`);
  console.log(`split == solo: ${same ? "IDENTICAL" : "DIVERGED"}`);

  server.close();
  if (gpuErrors.length) console.error("GPU errors:", gpuErrors.slice(0, 3));
  if (new Set(soloTokens).size <= 1) fail("degenerate output");
  if (!same) fail("split diverged from solo");
  console.log("REAL SPIKE PASS");
}

await main();
