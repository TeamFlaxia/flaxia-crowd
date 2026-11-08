# Executable model cache lifecycle

The `ai-inference` worker keeps at most two executable Transformers.js pipelines. Its identity includes task, registered model id, registered revision, dtype, and requested backend. Concurrent requests for the same identity share one load and receive leases. An active lease prevents eviction; when the cache is full, it evicts the least recently used idle pipeline and calls `dispose()`. If every slot is active, it rejects the new load with a capacity error instead of disposing a model in use.

Idle executable pipelines expire after 30 minutes. The Worker also releases loaded workload caches after one minute with no task. OOM or allocation errors invalidate the affected pipeline, which is disposed after its final lease ends. Terminating the Worker on consent revocation or explicit stop releases its execution resources with the Worker.

This is distinct from the on-disk model weight cache. Transformers.js may keep weight files in its own download cache, and swarm inference keeps fetched GGUF byte ranges in CacheStorage; neither means a model is currently executable in GPU/CPU memory. Swarm engines are created for a session and disposed when the session ends.

While a Worker is active, it reports executable entries with model id, revision, dtype, backend, optional layer range, state (`loading`, `ready`, `evicting`, `failed`), and reference count. The SDK bounds the snapshot to eight entries and a 60-second TTL. The Node forwards only a fresh validated snapshot with its heartbeat. Coordinator stores it as self-reported telemetry; it is not an authorization or capacity guarantee. Reconnection creates a fresh node record, and an expired or cleared snapshot is not considered current.
