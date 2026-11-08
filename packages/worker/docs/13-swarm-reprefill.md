# Swarm retry and streamed-output reset

The current WebGPU runtime does not export/import KV checkpoints. When a swarm member fails, the Coordinator aborts that attempt and retries from the original prompt with a new session and attempt. This is a full re-prefill, not continuation from the last token.

If the previous attempt already streamed tokens, the subscription receives `{ type: "reset", epoch }` before retry tokens arrive. SDK consumers should register `onReset` and clear the displayed/accumulated output for that task. The event is additive; clients that only need the terminal result can continue using `waitForTask()`.

The epoch increases on each retried attempt. A new attempt is not committed until the original task is scheduled again; if retries are exhausted, subscribers receive the existing terminal error instead. No KV bytes are stored or transferred by this contract.

Live token-boundary KV migration remains disabled until a backend can export and validate state with an explicit model revision, layer range, token position, and format. A backend-specific numerical tolerance and a rollback protocol are still required before migrating live state.
