# Generation acceptance baseline

Flaxia Crowdの生成確認は、Web・デスクトップとも **Qwen3.5-2Bの実モデル**を基準にします。
共通設定は `scripts/swarm-spike/generation-baseline.mjs` です。

| 条件 | 共通値 |
| --- | --- |
| model id | `qwen3.5-2b` |
| GGUF | `unsloth/Qwen3.5-2B-GGUF` / `Qwen3.5-2B-Q4_0.gguf` |
| 検証 | ファイルサイズとSHA-256をGPU起動前に照合 |
| prompt | `What is the capital of France? Answer in one sentence.` |
| output limit | 12 tokens、greedy |
| Web | 実Chromeのmodule workerでsoloと2-sliceのトークン列を比較 |
| desktop | SDK → 実workerd → Rustノード2台のレイヤー分割、実モデルで生成 |

両ターゲットで同じファイルを使います。合成GGUFを実モデルの代わりに渡すことはできません。
標準の生成確認では回答にParisを含むことも確認します。生成品質全般のベンチマークを意味しません。

GPU・Chrome・Deno・Rustを用意し、配布元から実モデルを取得したうえで実行します。
（約1.21 GB。URLのmain更新によりSHAが変わった場合は、確認してbaselineを更新してください。）

```sh
npm ci
npm run build --workspace=@flaxia/sdk
cargo build --locked --release --manifest-path packages/node-native/Cargo.toml
MODEL=/absolute/path/Qwen3.5-2B-Q4_0.gguf CHROME=/usr/bin/google-chrome npm run test:generation -- all
# 個別実行: 最後のallをwebまたはdesktopに変更
```

WebGPUバックエンドは通常の自動選択を使います。特定APIには固定しません。
CIの `Qwen3.5-2B generation acceptance` はPR・main/developへのpushで自動実行し、手動実行も可能です。
GitHub標準のUbuntu runnerでWeb / desktopを並列に実行します。WebはChromeのSwiftShader、desktopはMesaによるソフトウェアWebGPUを使う機能試験であり、実GPUハードウェアの性能測定ではありません。
約1.21 GBの実モデルはSHA-256別にキャッシュし、キャッシュ使用時にもファイルを照合します。生成ログはActions artifactへ保存します。
実モデルがない・GPUが使えない場合は失敗とし、合成モデルへフォールバックしません。
結果ログにはtarget・model・quantization・SHA・生成結果を記録します。

## Synthetic engine/transport checks

以下の小型モデルはCI・回帰試験用です。Qwen3.5-2Bの生成確認を完了した根拠には使いません。
`packages/node-native/tests/swarm-e2e.mjs` の通常モードもsynthetic transport smoke testです。

## Inference benchmark baseline

This harness gives single-engine and two-slice runs the same synthetic GGUF, prompt token IDs, output limit, device, warmup count, and measured repetition count. It is a deterministic engine/measurement baseline; its layer split passes hidden states inside one Deno process and does not measure browser WebRTC or Internet transport.

## Metrics

| Field | Definition |
| --- | --- |
| `coldLoadMs` | Time to create the engine(s) and upload weights to WebGPU. The synthetic GGUF is already built and parsed, so this excludes model download, GGUF generation, and parsing. It is present only for `repeatIndex: 0`; later samples report null because the engines stay resident. |
| `warmPrepareMs` | Time to reset the resident engine(s) before a request. This is the measured warm-reuse preparation path; it is not a disk-cache load. |
| `prefillMs` | Request start through processing the final prompt token and producing logits, before sampling the first output token. |
| `ttftMs` | Request start through sampling the first output token. It includes prefill and first-token sampling, but excludes engine load and warm preparation. |
| `decodeMs` | Time from first generated token through the remaining output tokens. |
| `tokensPerSecond` | `(output token count - 1) / decodeMs`; first-token latency is excluded. |
| `totalMs` | Request start through the last output token, including prefill, decode, and simulated layer-boundary delays; excludes engine load and reset. |
| `networkBytes` | Sum of hidden-state payload bytes in both directions at the synthetic layer boundary. Marked estimated because it excludes packet, WebRTC, and encryption overhead. Single-engine runs report zero. |
| `peakMemoryBytes` | Null/unknown: WebGPU does not expose peak or free memory. Model file bytes and estimated memory budgets are not mislabeled as peak usage. |

New runs write schema version 2, one JSONL row per measured attempt. The summarizer continues to accept version 1 rows. In version 2, `runId` is shared by all rows from one invocation; `sampleId` is unique per row and `repeatIndex` pairs single/split attempts. Rows include prompt ID, sampling mode, requested and actual output-token counts, model revision/quantization, code revision when supplied, node count/layer ranges, transport, OS/architecture, Deno version, WebGPU adapter identity when exposed, warmups, and scenario settings. `expectedOutcome` separates an injected node-loss result from an unexpected failure; low-memory admission refusal is `unavailable`. The summarizer reports linear-interpolated p50/p95, expected and unexpected failures, outcome mismatches, and unavailable metrics. `failureRate` counts failed rows over all planned rows, `unexpectedFailureRate` counts unexpected failures over completed-or-failed attempts, and `unavailableRate` counts unavailable rows over all planned rows.

## Run

```sh
deno run --unstable-webgpu \
  --allow-read=scripts/swarm-spike/run-synth.mjs,scripts/benchmarks/metrics.mjs,vendor/pooled \
  --allow-write=/tmp/flaxia-inference.jsonl \
  scripts/swarm-spike/run-synth.mjs \
  --warmups 1 --repeats 5 --tokens 24 --layers 8 --dim 256 \
  --code-revision "$(git rev-parse HEAD)" \
  --jsonl /tmp/flaxia-inference.jsonl

node scripts/benchmarks/summarize.mjs /tmp/flaxia-inference.jsonl
node --test scripts/benchmarks/metrics.test.mjs
```

The first measured repetition contains the cold engine-load time. Run the command in a fresh process several times to build a cold-load distribution; each invocation gets a new `runId`, while all rows from that invocation share it. Warmups are excluded from reported samples.

## Fault scenarios

```sh
# Add in-process latency and a bandwidth limit at each layer boundary.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,scripts/benchmarks/metrics.mjs,vendor/pooled --allow-write=/tmp/latency.jsonl \
  scripts/swarm-spike/run-synth.mjs --latency-ms 80 --bandwidth-mbps 10 --repeats 5 \
  --code-revision "$(git rev-parse HEAD)" --jsonl /tmp/latency.jsonl

# Simulate a peer disappearing before the next decode hop; failed attempts are kept in the results.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,scripts/benchmarks/metrics.mjs,vendor/pooled --allow-write=/tmp/dropout.jsonl \
  scripts/swarm-spike/run-synth.mjs --drop-after-tokens 4 --repeats 5 \
  --code-revision "$(git rev-parse HEAD)" --jsonl /tmp/dropout.jsonl

# Refuse before GPU allocation when the requested synthetic memory budget is below the estimate.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,scripts/benchmarks/metrics.mjs,vendor/pooled --allow-write=/tmp/low-memory.jsonl \
  scripts/swarm-spike/run-synth.mjs --memory-budget-mib 1 --repeats 3 \
  --code-revision "$(git rev-parse HEAD)" --jsonl /tmp/low-memory.jsonl
```

Latency and bandwidth are timer-based simulations at the in-process hidden-state boundary. Node loss is a deterministic injected exception. The low-memory case tests admission reporting against a conservative synthetic estimate; it does not force a real device OOM. These modes let CI and local runs exercise the result contract without root privileges or unstable hardware.

Injected node loss is recorded as `status: "failed"` and `expectedOutcome: "failed"` for the split samples; the single-node control samples remain expected to complete. Low-memory admission refusal is recorded as `status: "unavailable"` and `expectedOutcome: "unavailable"` for both topologies.

For real transport and real-device comparisons, run the multi-browser procedure added with the P2P runtime and preserve the same `model`, `conditions`, and `scenario` fields. Never compare a synthetic split result to a production transport run without labeling the transport difference.
