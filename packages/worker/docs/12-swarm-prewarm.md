# Swarm model prewarm tasks

`FlaxiaClient.prewarmSwarmModel()` submits a normal, tenant-scoped swarm task with a fixed prompt and a one-token generation. It exercises node connection, model loading, and the selected layer split; successful nodes populate their origin's persistent CacheStorage weight ranges for later loads.

Only model ids from the shared SDK allowlist are accepted. A node advertises `swarm-inference` only after the site has explicit model-download opt-in (`allowModelDownload: true`) and normal participation consent. The Coordinator accepts at most two prewarm requests per tenant per hour and schedules them as background priority 0 tasks through the existing bounded queue and pending TTL.

The response is a task id. Poll it with `getTask()` or `waitForTask()` to see whether the warm-up run succeeded. This stage warms downloaded weight ranges and verifies one real generation; it does not keep a GPU engine resident, reserve a node set, pin an immutable upstream model revision, replenish departed nodes, or promise that the same volunteers remain online. Browser storage eviction can remove cached weights, so later inference must still tolerate a cold load.
