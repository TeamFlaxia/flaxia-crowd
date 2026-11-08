# Priority and fair task scheduling

Task submission accepts an optional integer `priority` from 0 to 3. The default is 1. Higher values receive earlier consideration, but aging adds one effective level per 20 seconds of pending time, capped at 12. This lets old background work pass fresh interactive requests. Tasks in the same effective-priority band are interleaved across tenants by weighted round-robin; each tenant defaults to weight 1. Operators can set integer weights from 1 to 4 with `TENANT_SCHEDULING_WEIGHTS='{"tenant-a":2,"tenant-b":1}'`. Invalid entries are ignored and do not affect the default.

The existing `timeoutMs` is the task deadline. A pending task expires after the smaller of `timeoutMs` and five minutes, so short deadlines intentionally opt out of the full aging interval. Each scheduling pass reads at most the existing 500-entry queue cap and attempts at most 32 tasks. Node eligibility is still workload-specific; a task that no current node can run remains subject to its deadline. There is no preemption: priority applies before assignment only.

The task record includes `queueWaitMs` for its most recent assignment. Authenticated API keys can query only their own aggregate counters with `GET /crowd/queue/stats`: current pending counts by priority, cumulative assignment counts by priority, pending/assignment wait measures, and admission rejection counts. A retried task starts a new pending interval while preserving its overall task deadline.

The fairness guarantee is conditional on a task remaining pending, meeting its deadline, and having an eligible node. This scheduler does not guarantee a wall-clock completion time when capacity is unavailable.
