# Vendored: Pooled (SwarmLLM)

This directory contains a pinned copy of the inference engine from
[Nehanth/pooled](https://github.com/Nehanth/pooled) (formerly SwarmLLM), used by
the `swarm-inference` workload spike. Pooled is MIT-licensed; the upstream
`LICENSE` is kept at `vendor/pooled/LICENSE`.

## Provenance

- Upstream: `https://github.com/Nehanth/pooled`
- Commit: `d6491f3f0771f62abf695954fab1c0f8e6363bdb` (2026-09-28)
- Vendored: `engine/` and `tests/e2e/synth.mjs` (renamed `synth/synth.mjs`)
- Also kept: upstream `LICENSE`, `AUTHORS` and `CITATION.cff`
- License: MIT, Copyright (c) 2026 Nehanth Narendrula

## Derived files in this repository

These are our own files that port or adapt Pooled code and carry the MIT
attribution in their header:

- `packages/sdk/src/swarm.ts` — layer planner ported from `room/plan.js`
  (`planSplit`); frame kind/codec adapted from `room/transport.js`
- `packages/node/src/swarm/session.ts` — host/worker loop adapted from the
  chain protocol in `room.js` / `room/transport.js`
- `packages/node/src/swarm/adapter.ts` — wraps the vendored `Qwen35Engine` API
- `scripts/swarm-spike/run-synth.mjs` — adapted from `tests/e2e/engine_synth.mjs`
- `scripts/swarm-spike/check-webgpu-worker.mjs` — Chrome GPU flags and in-page
  flow adapted from the upstream e2e harness

## Local modifications

- `synth/synth.mjs`: `import fs from "fs"` / `import path from "path"` changed to
  the `node:` prefix so the synthetic-model generator also runs under Deno
  (the Phase 0 harness runtime). No logic changes.

## Updating

```bash
git clone --depth 1 https://github.com/Nehanth/pooled.git /tmp/pooled
cp -r /tmp/pooled/engine/. vendor/pooled/engine/
cp /tmp/pooled/tests/e2e/synth.mjs vendor/pooled/synth/synth.mjs
cp /tmp/pooled/LICENSE /tmp/pooled/AUTHORS /tmp/pooled/CITATION.cff vendor/pooled/
# re-apply the node: import patch, then update the commit above
```

## Phase 0 harness

`scripts/swarm-spike/run-synth.mjs` runs the vendored engine on a tiny synthetic
Qwen35 model over real WebGPU. It builds the model in memory, decodes greedily
solo, then again with the layers split across two engines (host + one hop) and
asserts both token streams are identical.

```bash
npm run spike:swarm
# or: deno run --unstable-webgpu --allow-read scripts/swarm-spike/run-synth.mjs --tokens 24
```

Deno is used because it exposes `navigator.gpu` headlessly. The production
runtime is a browser Web Worker; this harness de-risks the engine/adapter
boundary, not the transport. Verified on 2026-09-29: synthetic model, split
`4-7`, 24 tokens, `split == solo plain: IDENTICAL`.

`scripts/swarm-spike/check-webgpu-worker.mjs` covers the browser side: it serves
the vendored engine plus the synthetic GGUF, drives headless Chrome over CDP, and
runs a `Qwen35Engine` slice inside a `new Worker(url, { type: "module" })`.

```bash
npm run spike:webgpu-worker
# or: CHROME=/path/to/chrome node scripts/swarm-spike/check-webgpu-worker.mjs
```

Verified on 2026-09-29 with Chrome 148 headless (`--use-webgpu-adapter=swiftshader`):
the module worker got a WebGPU adapter/device (`google`/`swiftshader`,
`maxStorageBufferBindingSize=1073741824`) and decoded 12 tokens, matching the
Deno token stream. This confirms the production runtime (Web Worker) can host
the engine; SwiftShader is CPU emulation, so absolute speed is not meaningful.

`scripts/swarm-spike/run-real.mjs` runs a real GGUF (default Qwen3.5-2B Q4_0),
served over local HTTP Range and streamed tensor-by-tensor into GPU buffers the
way the production runtime loads — solo vs a 2-way layer split.

`scripts/swarm-spike/check-real-worker.mjs` does the same inside a dedicated
module worker in headless Chrome, on the real GPU:

```bash
npm run spike:real-worker
# PROMPT="The capital of France is" TOKENS=12 CHROME_GPU=real npm run spike:real-worker
```

Verified on 2026-09-29 with Chrome 148 headless
(`--use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist` →
NVIDIA Pascal): Qwen3.5-2B Q4_0 loaded through the streaming loader in a module
worker and both solo and the 2-way split produced identical, coherent output.
For the chat prompt "Where is The capital of France" the answer begins
`"The capital of France is **Paris**.\n\nLocated in the Île-de-F…"`, with no GPU
errors. Deno's WebGPU backend on the same box reports a spurious out-of-memory
for the 2B model, so use the Chrome harness for real weights.

