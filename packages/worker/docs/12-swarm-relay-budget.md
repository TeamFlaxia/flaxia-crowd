# Swarm Coordinator relay budget

The Coordinator's WebSocket binary relay is a compatibility path for swarms that cannot establish every required WebRTC DataChannel. Direct peer DataChannels do not consume this Coordinator relay budget.

Each task may relay at most 256 MiB cumulatively across its attempts. The counter is task-scoped and updated transactionally, so parallel frames and retries cannot reset or overspend it. The Coordinator forwards a frame only after reserving its full byte length. When the next frame would exceed the ceiling, the Coordinator aborts and permanently fails that task; retrying the same payload would only spend more relay capacity. Starting a new task creates a new budget.

The cap limits Coordinator-relayed payload volume. It is not a monetary estimate or a guarantee about a provider's billing. The current peer setup is STUN-only; deployments that need TURN must separately configure and budget their TURN service. A failed peer setup falls back to the bounded Coordinator path, while relay-budget exhaustion is reported as a task error.
