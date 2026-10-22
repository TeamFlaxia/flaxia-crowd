// Phase 0 spike: run the vendored Pooled (SwarmLLM) engine on the synthetic
// Qwen35 model, solo and split across two engines, on real WebGPU.
//
// Adapted from Nehanth/pooled tests/e2e/engine_synth.mjs
// (https://github.com/Nehanth/pooled), MIT, Copyright (c) 2026 Nehanth Narendrula.
// See vendor/pooled/VENDORED.md and vendor/pooled/LICENSE.
//
//   deno run --unstable-webgpu --allow-read scripts/swarm-spike/run-synth.mjs \
//     [--tokens 24] [--layers 8] [--dim 256] [--split 4] [--warmups 1] [--repeats 5]
//     [--latency-ms 0] [--bandwidth-mbps 0] [--drop-after-tokens 0] [--memory-budget-mib 512]
//     [--jsonl /tmp/flaxia-bench.jsonl]
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
const WARMUPS = +arg("warmups", 1);
const REPEATS = +arg("repeats", 5);
const LATENCY_MS = +arg("latency-ms", 0);
const BANDWIDTH_MBPS = +arg("bandwidth-mbps", 0) || null;
const DROP_AFTER_TOKENS = +arg("drop-after-tokens", 0) || null;
const MEMORY_BUDGET_MIB = arg("memory-budget-mib", "") === "" ? null : +arg("memory-budget-mib", "");
const JSONL_PATH = arg("jsonl", "");

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

  const chat = (text) => [
    V["<|im_start|>"], ...tok.encode("user\n" + text), V["<|im_end|>"], ...tok.encode("\n"),
    V["<|im_start|>"], ...tok.encode("assistant\n"),
    V["<think>"], ...tok.encode("\n\n"), V["</think>"], ...tok.encode("\n\n"),
  ];
  const prompt = chat("Write three sentences about the ocean.");
  const eos = new Set([V["<|im_end|>"], V["<|endoftext|>"]]);
  const optionValues = [TOKENS, LAYERS, DIM, WARMUPS, REPEATS, LATENCY_MS];
  if (optionValues.some((n) => !Number.isFinite(n)) || TOKENS < 1 || LAYERS < 1 || DIM < 1 ||
      !Number.isInteger(WARMUPS) || WARMUPS < 0 || !Number.isInteger(REPEATS) || REPEATS < 1 || LATENCY_MS < 0 ||
      (BANDWIDTH_MBPS !== null && (!Number.isFinite(BANDWIDTH_MBPS) || BANDWIDTH_MBPS <= 0)) ||
      (DROP_AFTER_TOKENS !== null && (!Number.isInteger(DROP_AFTER_TOKENS) || DROP_AFTER_TOKENS < 1)) ||
      (MEMORY_BUDGET_MIB !== null && (!Number.isFinite(MEMORY_BUDGET_MIB) || MEMORY_BUDGET_MIB < 0))) {
    fail("invalid benchmark option; check tokens/layers/dim/warmups/repeats and scenario values");
  }

  const estimatedMinimumBytes = Math.ceil(buf.byteLength + DIM * DIM * 8 + DIM * 256 * 4);
  const scenarioParts = [];
  if (LATENCY_MS > 0) scenarioParts.push(`latency-${LATENCY_MS}ms`);
  if (BANDWIDTH_MBPS !== null) scenarioParts.push(`bandwidth-${BANDWIDTH_MBPS}mbps`);
  if (DROP_AFTER_TOKENS !== null) scenarioParts.push(`node-loss-after-${DROP_AFTER_TOKENS}`);
  if (MEMORY_BUDGET_MIB !== null) scenarioParts.push(`memory-budget-${MEMORY_BUDGET_MIB}mib`);
  const scenario = {
    id: scenarioParts.join("+") || "baseline",
    latencyMs: LATENCY_MS,
    bandwidthMbps: BANDWIDTH_MBPS,
    dropAfterTokens: DROP_AFTER_TOKENS,
    memoryBudgetMiB: MEMORY_BUDGET_MIB,
    estimatedMinimumBytes,
  };
  const model = {
    id: "synthetic-qwen35",
    revision: `synth-l${LAYERS}-d${DIM}`,
    quantization: info?.quantization ?? "synthetic-mixed-ggml",
  };
  const baseConditions = {
    warmups: WARMUPS,
    repeats: REPEATS,
    inputTokens: prompt.length,
    requestedOutputTokens: TOKENS,
  };

  const writeSample = async (sample) => {
    const line = JSON.stringify(sample);
    console.log(`BENCHMARK ${line}`);
    if (JSONL_PATH) await Deno.writeTextFile(JSONL_PATH, `${line}\n`, { append: true, create: true });
  };

  const makeSample = (mode, status, metrics, metricSources, unavailableReasons, environment, error) => ({
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status,
    mode,
    scenario,
    model,
    environment,
    conditions: {
      ...baseConditions,
      topology: mode === "single" ? "one-node" : "two-node-layer-split",
    },
    metrics,
    metricSources,
    unavailableReasons,
    ...(error ? { error: String(error).slice(0, 512) } : {}),
  });

  if (MEMORY_BUDGET_MIB !== null && MEMORY_BUDGET_MIB * 1024 ** 2 < estimatedMinimumBytes) {
    const reason = `admission refused by synthetic budget estimate: needs ${estimatedMinimumBytes} bytes`;
    const gpu = { vendor: null, architecture: null };
    const environment = {
      runtime: "Deno", runtimeVersion: Deno.version.deno, os: Deno.build.os,
      architecture: Deno.build.arch, browser: null, gpu,
    };
    const metricNames = ["coldLoadMs", "warmPrepareMs", "ttftMs", "prefillMs", "decodeMs", "tokensPerSecond", "totalMs", "networkBytes", "peakMemoryBytes"];
    for (const mode of ["single", "split"]) {
      for (let i = 0; i < REPEATS; i++) {
        const metrics = Object.fromEntries(metricNames.map((name) => [name, null]));
        const metricSources = Object.fromEntries(metricNames.map((name) => [name, "unknown"]));
        await writeSample(makeSample(mode, "unavailable", metrics, metricSources, {
          coldLoadMs: reason, warmPrepareMs: reason, ttftMs: reason, prefillMs: reason,
          decodeMs: reason, tokensPerSecond: reason, totalMs: reason, networkBytes: reason,
          peakMemoryBytes: "WebGPU memory is not exposed by the synthetic runner",
        }, environment, reason));
      }
    }
    return;
  }

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

  const cutArg = +arg("split", Math.ceil(L / 2));
  const cut = cutArg > 0 && cutArg < L ? cutArg : Math.ceil(L / 2);
  const gpu = {
    vendor: adapter.info?.vendor || null,
    architecture: adapter.info?.architecture || null,
  };
  const environment = {
    runtime: "Deno",
    runtimeVersion: Deno.version.deno,
    os: Deno.build.os,
    architecture: Deno.build.arch,
    browser: null,
    gpu,
  };
  const metricNames = ["coldLoadMs", "warmPrepareMs", "ttftMs", "prefillMs", "decodeMs", "tokensPerSecond", "totalMs", "networkBytes", "peakMemoryBytes"];
  const writeRunSample = async (mode, index, loadMs, result, error = null) => {
    const metrics = {
      coldLoadMs: index === 0 ? loadMs : null,
      warmPrepareMs: result?.warmPrepareMs ?? null,
      ttftMs: result?.ttftMs ?? null,
      prefillMs: result?.prefillMs ?? null,
      decodeMs: result?.decodeMs ?? null,
      tokensPerSecond: result?.tokensPerSecond ?? null,
      totalMs: result?.totalMs ?? null,
      networkBytes: result?.networkBytes ?? null,
      peakMemoryBytes: null,
    };
    const metricSources = Object.fromEntries(metricNames.map((name) => {
      const value = metrics[name];
      if (value === null) return [name, "unknown"];
      if (name === "networkBytes" && mode === "split") return [name, "estimated"];
      return [name, "measured"];
    }));
    const unavailableReasons = {};
    if (index > 0) unavailableReasons.coldLoadMs = "the engine remained loaded after the first repetition";
    if (metrics.tokensPerSecond === null) unavailableReasons.tokensPerSecond = "decode duration or output token count was zero";
    if (metrics.peakMemoryBytes === null) unavailableReasons.peakMemoryBytes = "WebGPU does not expose total or peak memory";
    for (const name of metricNames) {
      if (metrics[name] === null && !unavailableReasons[name]) unavailableReasons[name] = error
        ? `run failed: ${String(error).slice(0, 300)}`
        : "metric was not available for this sample";
    }
    await writeSample(makeSample(mode, error ? "failed" : "completed", metrics, metricSources,
      unavailableReasons, environment, error));
    return result?.tokens ?? null;
  };

  const runSingle = async (engine) => {
    const prepStart = performance.now();
    engine.reset();
    const warmPrepareMs = performance.now() - prepStart;
    const startedAt = performance.now();
    await engine.prefillTokens(prompt.slice(0, -1));
    let next = argmax(await engine.forwardToken(prompt[prompt.length - 1]));
    const tokens = [next];
    const firstTokenAt = performance.now();
    while (tokens.length < TOKENS) {
      next = argmax(await engine.forwardToken(next));
      tokens.push(next);
    }
    const finishedAt = performance.now();
    const decodeMs = finishedAt - firstTokenAt;
    return {
      tokens,
      warmPrepareMs,
      ttftMs: firstTokenAt - startedAt,
      prefillMs: firstTokenAt - startedAt,
      decodeMs,
      tokensPerSecond: decodeMs > 0 && tokens.length > 1 ? (tokens.length - 1) * 1000 / decodeMs : null,
      totalMs: finishedAt - startedAt,
      networkBytes: 0,
    };
  };

  const runSplit = async (host, hop, injectNodeLoss) => {
    const prepStart = performance.now();
    host.reset();
    hop.reset();
    const warmPrepareMs = performance.now() - prepStart;
    const startedAt = performance.now();
    let networkBytes = 0;
    const chainOne = async (id, pos) => {
      const hidden = await host.embedRun(id, pos);
      networkBytes += hidden.byteLength;
      const serializationMs = BANDWIDTH_MBPS === null ? 0 : hidden.byteLength * 8 / (BANDWIDTH_MBPS * 1_000_000) * 1000;
      const waitMs = LATENCY_MS + serializationMs;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const returned = await hop.runHidden(hidden, pos);
      networkBytes += returned.byteLength;
      const returnWaitMs = LATENCY_MS + (BANDWIDTH_MBPS === null ? 0 : returned.byteLength * 8 / (BANDWIDTH_MBPS * 1_000_000) * 1000);
      if (returnWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, returnWaitMs));
      return returned;
    };

    let logits = null;
    let pos = 0;
    for (let i = 0; i < prompt.length; i++, pos++) {
      const hidden = await chainOne(prompt[i], pos);
      if (i === prompt.length - 1) logits = await host.headFromHidden(hidden);
    }
    let next = argmax(logits);
    const tokens = [next];
    const firstTokenAt = performance.now();
    while (tokens.length < TOKENS) {
      if (injectNodeLoss && DROP_AFTER_TOKENS !== null && tokens.length >= DROP_AFTER_TOKENS) {
        throw new Error(`simulated peer loss after ${tokens.length} generated tokens`);
      }
      const hidden = await chainOne(next, pos++);
      next = argmax(await host.headFromHidden(hidden));
      tokens.push(next);
    }
    const finishedAt = performance.now();
    const decodeMs = finishedAt - firstTokenAt;
    return {
      tokens,
      warmPrepareMs,
      ttftMs: firstTokenAt - startedAt,
      prefillMs: firstTokenAt - startedAt,
      decodeMs,
      tokensPerSecond: decodeMs > 0 && tokens.length > 1 ? (tokens.length - 1) * 1000 / decodeMs : null,
      totalMs: finishedAt - startedAt,
      networkBytes,
    };
  };

  let soloTokens = null;
  let unexpectedFailures = 0;
  const soloLoadStart = performance.now();
  const solo = await mk(0, L, true);
  const soloLoadMs = performance.now() - soloLoadStart;
  for (let i = 0; i < WARMUPS; i++) await runSingle(solo);
  for (let i = 0; i < REPEATS; i++) {
    try {
      const result = await runSingle(solo);
      const tokens = await writeRunSample("single", i, soloLoadMs, result);
      if (i === 0) soloTokens = tokens;
    } catch (error) {
      unexpectedFailures++;
      await writeRunSample("single", i, soloLoadMs, null, error);
    }
  }
  solo.dispose();

  const splitLoadStart = performance.now();
  const host = await mk(0, cut, true);
  const hop = await mk(cut, L, false);
  const splitLoadMs = performance.now() - splitLoadStart;
  for (let i = 0; i < WARMUPS; i++) await runSplit(host, hop, false);
  let splitTokens = null;
  for (let i = 0; i < REPEATS; i++) {
    try {
      const result = await runSplit(host, hop, true);
      const tokens = await writeRunSample("split", i, splitLoadMs, result);
      if (i === 0) splitTokens = tokens;
    } catch (error) {
      if (DROP_AFTER_TOKENS === null || !String(error).includes('simulated peer loss after')) unexpectedFailures++;
      await writeRunSample("split", i, splitLoadMs, null, error);
    }
  }
  host.dispose();
  hop.dispose();

  const same = soloTokens && splitTokens && soloTokens.length === splitTokens.length &&
    soloTokens.every((token, i) => token === splitTokens[i]);
  if (gpuErrors.length) fail(`${gpuErrors.length} GPU errors`);
  if (soloTokens && new Set(soloTokens).size <= 1) fail("degenerate token stream (all identical): prompt/template is wrong");
  if (DROP_AFTER_TOKENS === null && soloTokens && splitTokens && !same) {
    const at = soloTokens.findIndex((token, i) => token !== splitTokens[i]);
    fail(`split token stream diverged at ${at}`);
  }
  device.destroy();
  if (unexpectedFailures) fail(`${unexpectedFailures} unexpected benchmark failures`);
  console.log(`BENCHMARK PASS: ${REPEATS} repetitions per topology, ${WARMUPS} warmups, splitMatchesSingle=${same}`);
}

await main();
