// Phase 0 spike: run the vendored Pooled (SwarmLLM) engine on the synthetic
// Qwen35 model, solo and split across two engines, on real WebGPU.
//
// Adapted from Nehanth/pooled tests/e2e/engine_synth.mjs
// (https://github.com/Nehanth/pooled), MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
//
//   deno run --unstable-webgpu --allow-read scripts/swarm-spike/run-synth.mjs \
//     [--tokens 24] [--layers 8] [--dim 256] [--split 4]
//
// Why Deno: it exposes navigator.gpu headlessly, so CI boxes without a browser
// can still exercise the WGSL kernels. The production runtime is a browser Web
// Worker; this harness de-risks the engine/adapter boundary, not the transport.
import { buildSynthGGUF } from "../../vendor/pooled/synth/synth.mjs";
import { Qwen35Engine } from "../../vendor/pooled/engine/qwen35.js";
import {
  parseGGUFHeader,
  qwen35Weights,
  tokenizerFromGGUF,
  GGML_EMBED,
} from "../../vendor/pooled/engine/gguf.js";
import { makeTokenizer, argmax } from "../../vendor/pooled/engine/engine.js";

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf("--" + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TOKENS = +arg("tokens", 24);
const LAYERS = +arg("layers", 8);
const DIM = +arg("dim", 256);

function fail(msg) {
  console.error("SPIKE FAIL:", msg);
  process.exit(1);
}

async function main() {
  const t0 = performance.now();
  const { bytes, info } = buildSynthGGUF({ layers: LAYERS, dim: DIM });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const G = parseGGUFHeader(buf);
  const bytesOf = async (i) => new Uint8Array(buf, i.byteOffset, i.byteLength).slice();
  const tok = makeTokenizer(tokenizerFromGGUF(G.meta));
  const V = tok.vocab;
  const L = G.meta["qwen35.block_count"] - (G.meta["qwen35.nextn_predict_layers"] || 0);
  console.log(
    `synth model: ${(buf.byteLength / 2 ** 20).toFixed(2)} MB, ${L} trunk layers + nextn, dim ${G.meta["qwen35.embedding_length"]}, vocab ${G.meta["tokenizer.ggml.tokens"].length} (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) fail("no WebGPU adapter (run with --unstable-webgpu)");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  const gpuErrors = [];
  device.addEventListener("uncapturederror", (e) => {
    gpuErrors.push(e.error?.message ?? String(e.error));
    console.error("GPU ERROR:", e.error?.message ?? e.error);
  });
  console.log(
    `adapter: vendor=${adapter.info?.vendor} arch=${adapter.info?.architecture} subgroups=${adapter.features.has("subgroups")}`,
  );

  const eopts = { maxSeq: 256, batchCols: 4, coopRowsB: 4, coopWG: 64 };
  const mk = async (lo, hi, head) =>
    Qwen35Engine.create({
      device,
      meta: G.meta,
      layerRange: [lo, hi],
      hasEmbed: head,
      hasHead: head,
      vocab: G.tensors[GGML_EMBED].shape[0],
      ...eopts,
      weights: await qwen35Weights(G, bytesOf, { lo, hi, hasEmbed: head, hasHead: head, mtp: head }),
    });

  const chat = (text) => [
    V["<|im_start|>"], ...tok.encode("user\n" + text), V["<|im_end|>"], ...tok.encode("\n"),
    V["<|im_start|>"], ...tok.encode("assistant\n"),
    V["<think>"], ...tok.encode("\n\n"), V["</think>"], ...tok.encode("\n\n"),
  ];
  const prompt = chat("Write three sentences about the ocean.");
  const eos = new Set([V["<|im_end|>"], V["<|endoftext|>"]]);

  // ---- solo reference ----
  const solo = await mk(0, L, true);
  solo.reset();
  await solo.prefillTokens(prompt.slice(0, -1));
  let next = argmax(await solo.forwardToken(prompt[prompt.length - 1]));
  const soloTokens = [next];
  while (soloTokens.length < TOKENS) {
    next = argmax(await solo.forwardToken(next));
    soloTokens.push(next);
  }
  console.log(`solo plain: ${soloTokens.length} tokens, text=${JSON.stringify(tok.decode(soloTokens).slice(0, 80))}`);

  // ---- split chain: host holds [0, cut), hop holds [cut, L) ----
  const cutArg = +arg("split", Math.ceil(L / 2));
  const cut = cutArg > 0 && cutArg < L ? cutArg : Math.ceil(L / 2);
  const host = await mk(0, cut, true);
  const hop = await mk(cut, L, false);
  host.reset();
  hop.reset();

  const chainOne = async (id, pos) => {
    const h = await host.embedRun(id, pos);
    return hop.runHidden(h, pos);
  };

  let logits = null;
  let pos = 0;
  for (let i = 0; i < prompt.length; i++, pos++) {
    const h = await chainOne(prompt[i], pos);
    if (i === prompt.length - 1) logits = await host.headFromHidden(h);
  }
  let snext = argmax(logits);
  const splitTokens = [snext];
  while (splitTokens.length < TOKENS) {
    const h = await chainOne(snext, pos++);
    snext = argmax(await host.headFromHidden(h));
    splitTokens.push(snext);
  }

  const same = soloTokens.length === splitTokens.length && soloTokens.every((t, i) => t === splitTokens[i]);
  const distinct = new Set(soloTokens).size;
  const firstEos = soloTokens.findIndex((t) => eos.has(t));
  console.log(
    `split ${cut}-${L - 1}: ${splitTokens.length} tokens, distinct=${distinct}, firstEos=${firstEos} (${(-1 === firstEos ? "never" : firstEos)}), text=${JSON.stringify(tok.decode(splitTokens).slice(0, 80))}`,
  );
  console.log(`split == solo plain: ${same ? "IDENTICAL" : "DIVERGED"}`);

  if (gpuErrors.length) fail(`${gpuErrors.length} GPU errors`);
  if (distinct <= 1) fail("degenerate token stream (all identical): prompt/template is wrong");
  if (!same) {
    const at = soloTokens.findIndex((t, i) => t !== splitTokens[i]);
    fail(`split token stream diverged at ${at}`);
  }
  console.log("SPIKE PASS: engine runs and a 2-way layer split matches solo decoding.");
}

await main();
