# Inference scheduling and reservation leases

The Coordinator filters candidates by live connection, workload capability, task routing constraints, and device requirements before ranking them. The current ranking order is:

1. A ready executable cache entry or warm model range matching the requested model id.
2. Fresh measured GPU probe completion time (lower is better); missing or expired measurements stay unknown.
3. Known WASM or WebGPU buffer capacity (higher is better). A buffer limit is a capacity hint, not total/free VRAM.
4. Prior assignment count, then a fresh CPU load hint, connection age, and node id for stable ties.

`TaskRecord.placementReason` exposes the first ranking signal that separated the selected node from its runner-up. It is a compact operator/debugging hint and intentionally omits raw node telemetry. All resource and cache reports are self-reported hints; they do not prove identity, memory availability, model correctness, or tenant authorization. A task remains queued until an eligible node appears or the existing queue TTL expires. Peer RTT/bandwidth based placement is a separate follow-up that consumes the #38 telemetry contract.

Each assigned node now holds a reservation lease containing the task id, the delivery attempt generation, and the task deadline. The same Durable Object serializes allocation; a live lease also prevents a stale idle index entry from allocating that node twice. Completion, retry, cancellation/failure, and swarm teardown release only the matching task and generation. Expired leases are reconciled by the alarm and active attempts from a superseded generation cannot settle the task.

The scheduler reserves one task per node today. It does not claim a hard byte-level memory reservation because browsers do not expose free VRAM; low-memory filtering, probe hints, and runtime retry remain the safeguards until a backend reports a dependable allocation budget.
