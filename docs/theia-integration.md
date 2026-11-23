# Theia integration contract (`theia-inference`)

Theia is the chat service that runs small diffusion language models (dLLMs) across
Crowd nodes and merges their token distributions asynchronously. This document
defines the protocol contract **and** the node executor that serves it.

## Status

| Piece | State |
|---|---|
| `WorkloadType` / `WORKLOAD_TYPES` | declared |
| `DEFAULT_WORKLOAD_TIMEOUT_MS` | 1,800,000 ms |
| `HEAVY_WORKLOADS` | yes (a node holds dLLM weights and runs iterative denoising) |
| `ROUTABLE_WORKLOADS` | yes (base-model executor) |
| Worker submit validator | `isTheiaInferencePayload` |
| Node executor | `packages/node/src/workloads/theia.ts` + `friedflaxia/theia.ts` |
| Pinned base dLLM | `qwen3-0.6b-diffusion-bd3lm` (Q4_0, 342 MB) |
| LoRA adapters | not distributed yet; `expert` is rejected |
| Theia consumer | `TeamFlaxia/theia` `CrowdInference` (submit → poll) |

## Payload

```ts
interface TheiaInferencePayload {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; id?: string; createdAt?: number }>;
  model: string;                 // base model, e.g. 'qwen-dlm-4b'
  phase?: 'generate' | 'denoise'; // default 'generate'
  expert?: string;               // LoRA adapter id, e.g. 'code' | 'math' | 'chat'
  canvas?: TheiaCanvas;          // required for phase 'denoise'
  round?: number;                // denoise round (freshness / stale detection)
  steps?: number;                // denoise steps in this block round
  maxSteps?: number;             // default 128
  maxNewTokens?: number;         // generate response budget, default 64
  strength?: number;             // Self-Repulsion λ, default 64
  temperature?: number;          // node-side sampling, default 0.6
  mergeRule?: 'confidence-count' | 'logit-mean' | 'probability-mean' | 'poe';
  theia?: { preferWarm?: boolean };
}
```

`phase: 'generate'` runs a complete response for one expert (baseline and the
existing Theia `CrowdInference` path). `phase: 'denoise'` runs `steps` denoise
steps (default 8) over the supplied canvas (`canvas` is required, and forbidden
in generate mode) and returns edit deltas for the host reducer. `round` defaults
to 0. Placement is independent per task; there is no room or session record.

## Node executor

The node builds a Qwen chat prompt from `messages`, appends the canvas, masks the
open span tokens with `<|mask|>`, and runs low-confidence remasking with
`denoise_topk`:

- Open spans are grouped into **32-token blocks** (BD3LM's training block). A
  span longer than 32 tokens is generated left to right in 32-token chunks, not
  truncated. Closed spans stay in the text as context; if one falls inside a
  regenerated block its tokens are regenerated too, but no delta is returned
  for it.
- Open spans must fall on token boundaries, must not include leading/trailing
  whitespace, and are limited to `MAX_THEIA_DELTA_TEXT_CHARS` (512)
  characters. Otherwise the task fails with an explicit error instead of
  returning a delta the host would discard. Closed spans are only context and
  are not token-checked.
- The last span in a block grows into the generated tail **only when it ends at
  the canvas end**; otherwise it keeps its own token count so following text is
  not duplicated. Give the span enough characters for the expected answer.
- Commits are greedy top-1, most-confident first. `.steps` is per 32-token
  chunk; `result.steps` reports the total forwards actually spent.
- The prompt plus the padded block must fit `THEIA_MAX_CONTEXT_TOKENS = 512`
  (the validation model's training window). A canvas longer than
  `THEIA_MAX_CANVAS_CHARS = 16_000` is rejected before tokenization.
- `phase: 'generate'` uses the same loop over a masked response region and stops
  at `<|im_end|>`. `.maxNewTokens` bounds the response.
- Control markers (`<|...|>`) in message or canvas text are rejected: the
  tokenizer matches them verbatim, so allowing them would inject turns.
- A requested `expert` is rejected until LoRA adapters are distributed (T5); an
  adapter-loaded node also rejects an expert-less payload. The node never
  silently returns a base-model answer under an expert's name.
- `maxSteps`, `temperature`, `strength`, `mergeRule` and `theia.preferWarm` are
  accepted by the contract but not used by this executor. `maxNewTokens`
  controls the generate response; `steps` is per 32-token chunk.
- At most `MAX_THEIA_RESULT_DELTAS` (64) deltas are returned per task. A
  replacement is capped at `MAX_THEIA_DELTA_TEXT_CHARS` (512) characters; a
  longer open span must be split by the host.
  `result.model` is the pinned cache id (`qwen3-0.6b-diffusion-bd3lm`), not the
  requested alias.

The pinned model is `qwen3-0.6b-diffusion-bd3lm` (Q4_0, SHA-256 pinned in the
FriedFlaxia manifest). Nodes report it in `modelCache`, so the coordinator's
`resolveWarmModelId` can favor a warm node. There is no block/KV cache yet: one
step is a full forward over the block, which is why the default step budget is
small and the timeout is 30 minutes.

```ts
interface TheiaSpan {
  id: string;
  start: number;                 // UTF-16 offsets into canvas.text
  end: number;
}

interface TheiaCanvasSpan extends TheiaSpan {
  open: boolean;                 // false once committed (revisable if enabled)
}

interface TheiaCanvas {
  version: number;
  text: string;
  spans: TheiaCanvasSpan[];
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
  expertCount?: number;          // host fan-out K
  mergeRule?: TheiaMergeRule;
  nodes?: Array<{
    nodeId: string;
    expert?: string;
    confidence: number;          // 0..1
    steps: number;
    deltaCount?: number;
    ageRounds?: number;          // staleness in merge rounds when merged
  }>;
  durationMs: number;
}
```

`nodes` and `expertCount` are **host-side aggregates**: a single node task returns one
expert's deltas, and a node cannot observe how many deltas were later superseded.

## Host flow (target)

Theia is a **star topology**. The host owns the canvas and fans normal tasks out
to expert nodes; Crowd is a compute pool, not a session orchestrator.

1. The host builds a canvas (text + open span slots) for the response.
2. Every block round, it snapshots the canvas and submits one
   `theia-inference` task per expert (`phase: 'denoise'`, `steps: 8`, same
   `canvas.version`).
3. Each node runs its LoRA expert over the snapshot and returns `deltas`.
4. The host validates and accumulates deltas as evidence, then projects and
   commits with the gate (margin, support, persistence, cooldown, revision
   budget). Missing or slow experts contribute nothing to that round.
5. The committed canvas feeds the next block round until the stop rule fires
   (all spans committed, patience, or max rounds).

The reducer lives on the host. The coordinator stays an opaque relay and needs
no peer transport, layer planner, hop HMAC or session record: each round is a
set of ordinary tasks, placed independently. `ageRounds` carries staleness.

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
- Routing (planned, T5): expert capabilities such as `theia-expert-code`. The
  current capability schema is `WorkloadType[]`, so this needs an
  `expertCapabilities` field (or equivalent) before it can be advertised.
- Warm placement (planned, T5): the existing `modelCache` heartbeat extended
  with the adapter id. The base model is advertised today, so `preferWarm`
  places a theia task on a node that already holds the dLLM.


## Validation

The SDK exports the same guards the node/worker should use:

```ts
isTheiaInferencePayload(value)                       // messages/model/phase/canvas
isTheiaCanvas(value)                                 // bounds + sorted spans
isTheiaDelta(value, canvas, { allowRevisions })      // op -> editable span match
```

`isTheiaDelta` needs the canvas because v1 ops must target an existing editable
span; a shape-only check would accept deltas the host discards. Each delta is
capped at 8 ops and 512 chars/op; a denoise result should keep at most
`MAX_THEIA_RESULT_DELTAS` (64). Message `id`/`createdAt` are validated when
present; unknown extra fields are ignored.

## Model candidates

License safety comes first; avoid PolyForm Noncommercial models.

| Model | Params | License | Role |
|---|---|---|---|
| `yifanyu/QwenDLM-4B` | 4B | Apache-2.0 | primary (Qwen3-4B block diffusion) |
| `nvidia/Nemotron-Labs-Diffusion-3B` | 3B | NVIDIA Open Model License | 3B alternative |
| `dllm-hub/Qwen3-0.6B-diffusion-bd3lm-v0.1` | 0.8B | Apache-2.0 | algorithm validation |

## Rollout checklist

- [x] Declare the payload/result contract, phase, canvas and delta types.
- [x] Add the submit validation branch in the worker using the SDK guards.
- [x] Add the node executor: `generate` and `denoise` over the pinned base dLLM.
- [x] Move `theia-inference` into `ROUTABLE_WORKLOADS` with the executor.
- [ ] Add expert capabilities (`theia-expert-*`), distribute LoRA adapters and
      extend warm `modelCache` entries with the adapter id (T5).
- [ ] Add the block/KV cache so a denoise step does not recompute the prefix.
- [ ] Add a Theia single-expert / multi-expert generation check.
