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
  model: string;                 // base model, e.g. 'qwen-dlm-4b'
  phase?: 'generate' | 'denoise'; // default 'generate'
  expert?: string;               // LoRA adapter id, e.g. 'code' | 'math' | 'chat'
  canvas?: TheiaCanvas;          // required for phase 'denoise'
  round?: number;                // denoise round (freshness / stale detection)
  steps?: number;                // denoise steps in this block round
  maxSteps?: number;             // default 128
  strength?: number;             // Self-Repulsion λ, default 64
  temperature?: number;          // default 0.6
  mergeRule?: 'confidence-count' | 'logit-mean' | 'probability-mean' | 'poe';
  theia?: { minNodes?: number; maxNodes?: number; preferWarm?: boolean };
}
```

`phase: 'generate'` runs a complete response for one expert (baseline and the
existing Theia `CrowdInference` path). `phase: 'denoise'` runs `steps` denoise
steps over the supplied canvas and returns edit deltas for the host reducer.

```ts
interface TheiaSpan {
  id: string;
  start: number;                 // UTF-16 offsets into canvas.text
  end: number;
  open: boolean;                 // false once committed (revisable if enabled)
}

interface TheiaCanvas {
  version: number;
  text: string;
  spans: TheiaSpan[];
}

type TheiaEditOp = {
  kind: 'replace';               // v1 is replace-only
  span: [number, number];        // must match an editable span
  text: string;
  tokenProbs?: number[];
};

interface TheiaDelta {
  id: string;                    // idempotency key
  expert: string;
  baseVersion: number;           // canvas version this proposal edits
  round: number;
  ops: TheiaEditOp[];
  confidence: number;            // 0..1, host calibrates it
  entropy?: number;
  ageRounds?: number;
}
```

**Delta granularity (v1).** `replace` only, with a span slot that may change
length when committed. Insert/delete need stable span ids and Levenshtein
alignment (LLaDA2.2 style) and are a later protocol version. Revisions of a
committed span are behind `allowRevisions`, which is off by default, so v1
commits each span once and cannot oscillate.

## Result

```ts
interface TheiaInferenceResult {
  output?: string;               // generate
  deltas?: TheiaDelta[];         // denoise
  canvasVersion?: number;
  round?: number;
  model: string;
  steps: number;
  expert?: string;
  phase?: 'generate' | 'denoise';
  tokens?: string[];
  paths?: number;
  mergeRule?: TheiaMergeRule;
  nodes?: Array<{
    nodeId: string;
    expert?: string;
    confidence: number;          // 0..1
    steps: number;
    deltaCount?: number;
    revertCount?: number;
    ageSteps?: number;           // staleness when merged
  }>;
  durationMs: number;
}
```

## Host flow (target)

Theia is a **star topology**. The host owns the canvas and fans normal tasks out
to expert nodes; Crowd is a compute pool, not a session orchestrator.

1. The host builds a canvas (text + open span slots) for the response.
2. Every block round, it snapshots the canvas and submits one
   `theia-inference` task per expert (`phase: 'denoise'`, `steps: 8`, same
   `canvasVersion`).
3. Each node runs its LoRA expert over the snapshot and returns `deltas`.
4. The host validates and accumulates deltas as evidence, then projects and
   commits with the gate (margin, support, persistence, cooldown, revision
   budget). Missing or slow experts contribute nothing to that round.
5. The committed canvas feeds the next block round until the stop rule fires
   (all spans committed, patience, or max rounds).

The reducer lives on the host. The coordinator stays an opaque relay and needs
no peer transport, layer planner, hop HMAC or session record: each round is a
set of ordinary tasks, placed independently. `ageRounds` carries staleness.

`swarm-inference` is therefore slated for removal once this executor lands. The
contract above does not depend on any swarm type.

## Asynchrony

The research question is how much staleness the merge tolerates. Deltas carry
`baseVersion` and `round`; the host rejects a delta whose base version is not the
current snapshot and decays evidence by `decay^age`. A soft deadline (all experts
or `T` ms) means a straggler never blocks the round.

## LoRA experts (v1)

Heterogeneous tokenizers are deferred. v1 uses one base model (QwenDLM-4B, with
Qwen3-0.6B-bd3lm for algorithm validation) plus LoRA adapters for `code`,
`math`, and `chat`. The tokenizer and vocabulary are shared by construction, so
deltas and confidences are directly comparable.

- Distribution: base GGUF + adapter files, each pinned by SHA-256.
- Routing: node capabilities such as `theia-expert-code`; no grouping logic.
- Warm placement: the existing `modelCache` heartbeat, extended with the adapter
  id.


## Model candidates

License safety comes first; avoid PolyForm Noncommercial models.

| Model | Params | License | Role |
|---|---|---|---|
| `yifanyu/QwenDLM-4B` | 4B | Apache-2.0 | primary (Qwen3-4B block diffusion) |
| `nvidia/Nemotron-Labs-Diffusion-3B` | 3B | NVIDIA Open Model License | 3B alternative |
| `dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1` | 0.8B | Apache-2.0 | algorithm validation |

## Rollout checklist

- [x] Declare the payload/result contract, phase, canvas and delta types.
- [ ] Add `validateTheiaInferencePayload` and the submit dispatch branch in the
      worker (`packages/worker/src/crowd/index.ts`), using the SDK guards.
- [ ] Add the node executor: `generate` first, then `denoise` with
      `denoise_step` + a LoRA adapter.
- [ ] Add expert capabilities (`theia-expert-*`) and extend warm `modelCache`
      entries with the adapter id.
- [ ] Move `theia-inference` into `ROUTABLE_WORKLOADS` only after the executor
      and the contract tests pass.
- [ ] Remove `swarm-inference` and its chain/peer/layer-plan machinery once the
      Theia executor is the supported distributed path.
- [ ] Replace the Qwen3.5 generation acceptance workflow with a Theia
      single-expert / multi-expert generation check.
