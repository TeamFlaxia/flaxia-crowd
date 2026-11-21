# Theia integration contract (`theia-inference`)

Theia is the chat service that runs small diffusion language models (dLLMs) across
Crowd nodes and merges their token distributions asynchronously. This document
defines the **protocol contract** that is shared today. The node executor is not
implemented yet, so `theia-inference` is declared but deliberately excluded from
`ROUTABLE_WORKLOADS` (the same staging used by `moe-inference`).

## Status

| Piece | State |
|---|---|
| `WorkloadType` / `WORKLOAD_TYPES` | declared |
| `DEFAULT_WORKLOAD_TIMEOUT_MS` | 1,800,000 ms |
| `HEAVY_WORKLOADS` | yes (a node holds dLLM weights and runs iterative denoising) |
| `ROUTABLE_WORKLOADS` | **no** until a node executor lands |
| Worker submit validator | pending (non-routable workloads are rejected at submit) |
| Node executor | pending |
| Theia consumer | `TeamFlaxia/theia` `CrowdInference` (submit → poll) |

## Payload

```ts
interface TheiaInferencePayload {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model: string;                 // e.g. 'qwen-dlm-4b'
  maxSteps?: number;             // default 128
  strength?: number;             // Self-Repulsion λ, default 64
  temperature?: number;          // default 0.6
  mergeRule?: 'confidence-count' | 'logit-mean' | 'probability-mean' | 'poe';
  theia?: { minNodes?: number; maxNodes?: number; preferWarm?: boolean };
}
```

## Result

```ts
interface TheiaInferenceResult {
  output: string;
  tokens: string[];
  model: string;
  steps: number;
  paths: number;                 // K, the number of merged denoising paths
  mergeRule: TheiaMergeRule;
  nodes: Array<{
    nodeId: string;
    confidence: number;          // 0..1
    steps: number;
    ageSteps?: number;           // staleness when merged
  }>;
  durationMs: number;
}
```

## Host flow (target)

1. Theia submits `theia-inference` with the conversation and model id.
2. The coordinator selects `theia-inference`-capable nodes (WebGPU + model
   download consent + heavy-memory gate), mirroring `tryAssignSwarm`.
3. Each node runs denoise steps over the same canvas and returns per-position
   token distributions (logits), not sampled tokens.
4. The host merges proposals with the configured rule:
   - `confidence-count` — weighted probability mean minus the Self-Repulsion
     count penalty (default).
   - `probability-mean` / `logit-mean` / `poe` — ablations.
   Stale proposals are discounted by `exp(-decay × ageSteps)`.
5. The merged canvas feeds the next step; the final canvas is decoded to text.

The reducer lives on the host, matching `swarm-inference`'s
host-authoritative settlement. The coordinator stays an opaque relay; a new
frame kind (token distributions) is required because the existing swarm frame
carries a single f16 hidden state.

## Asynchrony

The research question is how much staleness the merge tolerates. The v1
protocol carries `ageSteps` per proposal so the host can apply time decay
without changing the wire shape later. A soft barrier (quorum / deadline)
avoids waiting for stragglers.

## Model candidates

License safety comes first; avoid PolyForm Noncommercial models.

| Model | Params | License | Role |
|---|---|---|---|
| `yifanyu/QwenDLM-4B` | 4B | Apache-2.0 | primary (Qwen3-4B block diffusion) |
| `nvidia/Nemotron-Labs-Diffusion-3B` | 3B | NVIDIA Open Model License | 3B alternative |
| `dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1` | 0.8B | Apache-2.0 | algorithm validation |

## Rollout checklist

- [ ] Add `validateTheiaInferencePayload` and the submit dispatch branch in the
      worker (`packages/worker/src/crowd/index.ts`).
- [ ] Generalize `tryAssignSwarm` / `SwarmRecord` in `Coordinator.ts`, or add a
      parallel `TheiaRecord` with the same attempt fencing and reservations.
- [ ] Add the node executor and the distribution frame codec in the SDK.
- [ ] Move `theia-inference` into `ROUTABLE_WORKLOADS` only after the executor
      and the contract tests pass.
- [ ] Measure the relay budget and subscriber window; diffusion fan-out can
      exceed the 256 MiB/task relay budget used by swarm.
