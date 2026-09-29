# Vendored: Pooled (SwarmLLM)

This directory contains a pinned copy of the inference engine from
[Nehanth/pooled](https://github.com/Nehanth/pooled) (formerly SwarmLLM), used by
the `swarm-inference` workload spike. Pooled is MIT-licensed; the upstream
`LICENSE` is kept at `vendor/pooled/LICENSE`.

## Provenance

- Upstream: `https://github.com/Nehanth/pooled`
- Commit: `d6491f3f0771f62abf695954fab1c0f8e6363bdb` (2026-09-28)
- Vendored: `engine/` and `tests/e2e/synth.mjs` (renamed `synth/synth.mjs`)

## Local modifications

- `synth/synth.mjs`: `import fs from "fs"` / `import path from "path"` changed to
  the `node:` prefix so the synthetic-model generator also runs under Deno
  (the Phase 0 harness runtime). No logic changes.

## Updating

```bash
git clone --depth 1 https://github.com/Nehanth/pooled.git /tmp/pooled
cp -r /tmp/pooled/engine/. vendor/pooled/engine/
cp /tmp/pooled/tests/e2e/synth.mjs vendor/pooled/synth/synth.mjs
cp /tmp/pooled/LICENSE vendor/pooled/LICENSE
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

