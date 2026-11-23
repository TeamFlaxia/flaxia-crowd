# Inference failure recovery

## Node loss

The Coordinator detects a closed final socket immediately. If the connection stays open but stops responding, the node becomes stale after 60 seconds without a pong. A failed assignment retires its attempt id, sends abort to the assigned node, releases the node reservation leases, and retries up to three times while the task deadline permits.

Each retry gets a new attempt id. A late result from a previous attempt is ignored. The coordinator reloads the original task payload and prompt; it does not reuse KV state from a failed attempt. This full re-prefill path is the safe fallback because the current runtime has no portable, verified KV-cache checkpoint format.

Placement and retry continue to use the original tenant scope, workload constraints, and site allow-list. When retries are exhausted or the task deadline expires, the task is failed and all matching reservations are released.

The regression test covers abrupt node loss, a fresh attempt id, rejection of a stale attempt result, replay of the original prompt, and cleanup of the node lease. Real multi-node disconnect testing still requires a browser harness.
