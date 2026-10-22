# Inference benchmark baseline

This harness gives single-engine and two-slice runs the same synthetic GGUF, prompt token IDs, output limit, device, warmup count, and measured repetition count. It is a deterministic engine/measurement baseline; its layer split passes hidden states inside one Deno process and does not measure browser WebRTC or Internet transport.

## Metrics

| Field | Definition |
| --- | --- |
| `coldLoadMs` | Time to create the engine(s) and load model weights for the first run in one process. Later repetitions leave it null because the engine remains resident. |
| `warmPrepareMs` | Time to reset a resident engine before one request. It is a warm reuse measure, not another model download. |
| `ttftMs` / `prefillMs` | Request start after warm preparation through the first generated token. Model load is reported separately. |
| `decodeMs` | Time from first generated token through the remaining output tokens. |
| `tokensPerSecond` | `(output token count - 1) / decodeMs`; first-token latency is excluded. |
| `totalMs` | Request start through all requested output tokens, excluding engine load and reset. |
| `networkBytes` | Hidden-state payload bytes handed across the synthetic layer boundary. Marked estimated because it excludes packet, WebRTC, and encryption overhead. Single-engine runs report zero. |
| `peakMemoryBytes` | Null/unknown: WebGPU does not expose peak or free memory. Model file bytes and estimated memory budgets are not mislabeled as peak usage. |

Every JSONL row records model revision/quantization, input and output token counts, topology, OS/architecture, Deno version, adapter identity when exposed, warmups, repetitions, and scenario settings. The summarizer reports linear-interpolated p50/p95, failures, unavailable metrics, and failure rate by topology and scenario.

## Run

```sh
deno run --unstable-webgpu \
  --allow-read=scripts/swarm-spike/run-synth.mjs,vendor/pooled \
  --allow-write=/tmp/flaxia-inference.jsonl \
  scripts/swarm-spike/run-synth.mjs \
  --warmups 1 --repeats 5 --tokens 24 --layers 8 --dim 256 \
  --jsonl /tmp/flaxia-inference.jsonl

node scripts/benchmarks/summarize.mjs /tmp/flaxia-inference.jsonl
node --test scripts/benchmarks/metrics.test.mjs
```

The first measured repetition contains the cold engine-load time. Run the command in a fresh process several times to build a cold-load distribution; all rows can be appended to the same JSONL file. Warmups are excluded from reported samples.

## Fault scenarios

```sh
# Add in-process latency and a bandwidth limit at each layer boundary.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,vendor/pooled --allow-write=/tmp/latency.jsonl \
  scripts/swarm-spike/run-synth.mjs --latency-ms 80 --bandwidth-mbps 10 --repeats 5 --jsonl /tmp/latency.jsonl

# Simulate a peer disappearing before the next decode hop; failed attempts are kept in the results.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,vendor/pooled --allow-write=/tmp/dropout.jsonl \
  scripts/swarm-spike/run-synth.mjs --drop-after-tokens 4 --repeats 5 --jsonl /tmp/dropout.jsonl

# Refuse before GPU allocation when the requested synthetic memory budget is below the estimate.
deno run --unstable-webgpu --allow-read=scripts/swarm-spike/run-synth.mjs,vendor/pooled --allow-write=/tmp/low-memory.jsonl \
  scripts/swarm-spike/run-synth.mjs --memory-budget-mib 1 --repeats 3 --jsonl /tmp/low-memory.jsonl
```

Latency and bandwidth are timer-based simulations at the in-process hidden-state boundary. Node loss is a deterministic injected exception. The low-memory case tests admission reporting against a conservative synthetic estimate; it does not force a real device OOM. These modes let CI and local runs exercise the result contract without root privileges or unstable hardware.

For real transport and real-device comparisons, run the multi-browser procedure added with the P2P runtime and preserve the same `model`, `conditions`, and `scenario` fields. Never compare a synthetic split result to a production transport run without labeling the transport difference.
