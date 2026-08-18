import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type { TaskRecord, WorkloadType } from "@flaxia/sdk";
import { signPayload } from "../security";

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_RETRIES = 3;
export const STALE_NODE_MS = 60000;
export const ALARM_INTERVAL_MS = 30000;

interface NodeRecord {
  id: string;
  status: "idle" | "busy";
  capabilities: WorkloadType[];
  cpuLoad: number;
  connectedAt: number;
  lastPongAt: number;
  currentTaskId?: string;
  /** True when the device is a mobile WebView / has < 4 GB RAM. */
  lowMemory?: boolean;
}

/** Heavy WebAssembly workloads that can kill a low-memory device. */
const HEAVY_WORKLOADS: ReadonlySet<string> = new Set([
  "ai-inference",
  "vector-embed",
  "vector-query",
  "nudenet",
  "image-process",
  "container",
]);

interface RateEntry {
  count: number;
  resetAt: number;
}

export class Coordinator extends DurableObject<Env> {
  private pendingCache: string[] | null = null;
  private processingCache: string[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (!(await this.checkRateLimit(request, "signal"))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return this.handleWebSocket(request, url);
    }

    if (url.pathname === "/subscribe") {
      if (!(await this.checkRateLimit(request, "subscribe"))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return this.handleSubscribe(request, url);
    }

    if (url.pathname === "/enqueue") {
      return this.handleEnqueue(request);
    }

    if (url.pathname.startsWith("/task/")) {
      const taskId = url.pathname.slice(6);
      const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
      if (!task) return new Response("Not found", { status: 404 });
      return Response.json(task);
    }

    return new Response("Not Found", { status: 404 });
  }

  // --- WebSocket: Node signaling ---

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const nodeId = url.searchParams.get("nodeId");
    if (!nodeId) return new Response("nodeId is required", { status: 400 });
    const capabilities = (url.searchParams.get("capabilities") || "").split(",").filter(Boolean) as WorkloadType[];

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // If the node reconnects while a task is still in flight, keep the task
    // assigned to this node and deliver it on the new socket. Failing and
    // requeueing here would redeliver the same task on every reconnect
    // (mobile / tab-switch flapping) and consume retry budget, so a single
    // task could be dispatched to the node many times in a short window.
    const existing = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    let resumeTask: TaskRecord | undefined;
    if (existing?.currentTaskId) {
      const inFlight = await this.ctx.storage.get<TaskRecord>(`task:${existing.currentTaskId}`);
      if (inFlight && inFlight.status === "processing" && inFlight.assignedNodeId === nodeId) {
        resumeTask = inFlight;
      }
    }

    this.ctx.acceptWebSocket(server, [nodeId]);

    for (const sock of this.ctx.getWebSockets(nodeId)) {
      if (sock === server) continue;
      try { sock.close(); } catch {}
    }

    const node: NodeRecord = {
      id: nodeId,
      status: resumeTask ? "busy" : "idle",
      capabilities,
      cpuLoad: existing?.cpuLoad ?? 0,
      connectedAt: existing?.connectedAt ?? Date.now(),
      lastPongAt: Date.now(),
      currentTaskId: resumeTask?.id,
      lowMemory: url.searchParams.get("lowMemory") === "true",
    };

    await this.ctx.storage.put(`node:${nodeId}`, node);

    const idleNodes = await this.getIdleNodes();
    if (resumeTask) {
      await this.ctx.storage.put("nodes:idle", idleNodes.filter(id => id !== nodeId));
    } else if (!idleNodes.includes(nodeId)) {
      idleNodes.push(nodeId);
      await this.ctx.storage.put("nodes:idle", idleNodes);
    }

    // Continue the in-flight task on the new socket so the node can finish it
    // instead of the coordinator requeueing a duplicate.
    if (resumeTask) {
      if (!(await this.deliverTask(resumeTask, server))) {
        await this.failTask(resumeTask.id, "Failed to deliver task to node");
      }
    }

    await this.tryAssignAll();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws);
    const nodeId = tags[0];

    if (!nodeId || nodeId.startsWith("client:")) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message as string);
    } catch {
      return;
    }

    try {
      if (data.type === "pong") {
        const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
        if (node) {
          node.lastPongAt = Date.now();
          const load = typeof data.cpuLoad === "number" ? data.cpuLoad : 0;
          node.cpuLoad = Math.min(1, Math.max(0, load));
          await this.ctx.storage.put(`node:${nodeId}`, node);
        }
        return;
      }

      if (data.type === "result" || data.type === "error") {
        const isError = data.type === "error";
        const taskId = typeof data.taskId === "string" ? data.taskId : "";

        if (isError) {
          const error = typeof data.error === "string" ? data.error : "Node error";
          await this.failTask(taskId, error, nodeId);
        } else {
          await this.completeTask(taskId, data.payload, nodeId);
        }

        await this.tryAssignAll();
        return;
      }

      if (data.type === "progress") {
        const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
        if (!node || node.currentTaskId !== data.taskId) return;
        if (typeof data.token !== "string") return;

        const subs = this.ctx.getWebSockets(`client:${data.taskId}`);
        const msg = JSON.stringify({ type: "token", token: data.token });
        for (const sub of subs) {
          try { sub.send(msg); } catch {}
        }
        return;
      }
    } catch {}
  }

  async webSocketClose(ws: WebSocket) {
    const tags = this.ctx.getTags(ws);
    const tag = tags[0];

    if (!tag) {
      try { ws.close(); } catch {}
      return;
    }

    if (tag.startsWith("client:")) {
      try { ws.close(); } catch {}
      return;
    }

    // Reciprocate the close frame. Required for compatibility dates before 2026-04-07.
    try { ws.close(); } catch {}

    const otherSockets = this.ctx.getWebSockets(tag).filter(s => s !== ws);
    if (otherSockets.length > 0) return;

    const node = await this.ctx.storage.get<NodeRecord>(`node:${tag}`);
    if (node?.currentTaskId) {
      await this.failTask(node.currentTaskId, "Node disconnected", undefined, false);
    }

    await this.ctx.storage.delete(`node:${tag}`);
    const idleNodes = await this.getIdleNodes();
    await this.ctx.storage.put("nodes:idle", idleNodes.filter(id => id !== tag));

    await this.tryAssignAll();
  }

  // --- WebSocket: Subscriber ---

  private async handleSubscribe(request: Request, url: URL): Promise<Response> {
    const taskId = url.searchParams.get("taskId");
    if (!taskId) return new Response("taskId is required", { status: 400 });

    const existing = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    if (!existing) return new Response("Task not found", { status: 404 });

    if (existing.status === "done" || existing.status === "failed") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const msg = existing.status === "done"
        ? { type: "done", result: existing.result }
        : { type: "error", error: existing.error };
      server.send(JSON.stringify(msg));
      server.close();
      return new Response(null, { status: 101, webSocket: client });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [`client:${taskId}`]);
    server.send(JSON.stringify({ type: "subscribed", taskId }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Task management ---

  private async handleEnqueue(request: Request): Promise<Response> {
    let body: TaskRecord;
    try {
      body = await request.json() as TaskRecord;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body?.id) return Response.json({ error: "Task id is required" }, { status: 400 });

    await this.ctx.storage.put(`task:${body.id}`, body);

    const pending = await this.getPending();
    pending.push(body.id);
    this.pendingCache = pending;
    await this.ctx.storage.put("queue:pending", pending);

    await this.tryAssignAll();

    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > Date.now() + (body.timeoutMs || DEFAULT_TIMEOUT_MS)) {
      await this.ctx.storage.setAlarm(Date.now() + (body.timeoutMs || DEFAULT_TIMEOUT_MS));
    }

    return Response.json({ message: "Task submitted", taskId: body.id });
  }

  private async completeTask(taskId: string, result: unknown, nodeId: string) {
    const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    if (!task || task.status !== "processing") return;
    if (task.assignedNodeId !== nodeId) return;

    task.status = "done";
    task.result = result;
    task.completedAt = Date.now();
    await this.ctx.storage.put(`task:${taskId}`, task);

    await this.releaseNode(nodeId);

    const processing = await this.getProcessing();
    this.processingCache = processing.filter(id => id !== taskId);
    await this.ctx.storage.put("queue:processing", this.processingCache);

    const subs = this.ctx.getWebSockets(`client:${taskId}`);
    const msg = JSON.stringify({ type: "done", result });
    for (const sub of subs) {
      try { sub.send(msg); sub.close(); } catch {}
    }

    if (task.callbackUrl) {
      await this.deliverCallback(task.callbackUrl, {
        taskId, status: 'done', result: task.result,
      });
    }
  }

  private async failTask(taskId: string, error: string, expectedNodeId?: string, release = true) {
    const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    if (!task || (task.status !== "pending" && task.status !== "processing")) return;
    if (expectedNodeId && task.assignedNodeId && task.assignedNodeId !== expectedNodeId) return;

    if (task.assignedNodeId && release) {
      await this.releaseNode(task.assignedNodeId);
    }

    // Retry transient failures (timeout / disconnect) up to MAX_RETRIES times.
    // Keyed on retryCount (not status) so a task that was already requeued by
    // an earlier failure keeps its remaining retries instead of being
    // permanently failed by a second overlapping failure signal.
    if (task.retryCount < MAX_RETRIES) {
      if (task.status === "processing") task.retryCount++;
      task.status = "pending";
      task.assignedNodeId = undefined;
      task.assignedAt = undefined;
      await this.ctx.storage.put(`task:${taskId}`, task);

      const processing = await this.getProcessing();
      this.processingCache = processing.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:processing", this.processingCache);

      const pending = await this.getPending();
      if (!pending.includes(taskId)) {
        pending.push(taskId);
        this.pendingCache = pending;
        await this.ctx.storage.put("queue:pending", pending);
      }
      return;
    }

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    await this.ctx.storage.put(`task:${taskId}`, task);

    if (task.assignedNodeId) {
      const processing = await this.getProcessing();
      this.processingCache = processing.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:processing", this.processingCache);
    } else {
      const pending = await this.getPending();
      this.pendingCache = pending.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:pending", this.pendingCache);
    }

    const subs = this.ctx.getWebSockets(`client:${taskId}`);
    const msg = JSON.stringify({ type: "error", error });
    for (const sub of subs) {
      try { sub.send(msg); sub.close(); } catch {}
    }

    if (task.callbackUrl) {
      await this.deliverCallback(task.callbackUrl, {
        taskId, status: 'failed', error: task.error,
      });
    }
  }

  private async releaseNode(nodeId: string) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    if (!node) return;
    node.status = "idle";
    node.currentTaskId = undefined;
    await this.ctx.storage.put(`node:${nodeId}`, node);

    const idleNodes = await this.getIdleNodes();
    if (!idleNodes.includes(nodeId)) {
      idleNodes.push(nodeId);
      await this.ctx.storage.put("nodes:idle", idleNodes);
    }
  }

  private async deliverCallback(url: string, body: Record<string, unknown>) {
    try {
      const payload = JSON.stringify(body);
      const signature = this.env.NODE_TOKEN_SECRET
        ? await signPayload(this.env.NODE_TOKEN_SECRET, payload)
        : '';
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'X-Flaxia-Signature': signature } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Callback failure is non-critical; task result remains available via REST API
    }
  }

  private async deliverTask(task: TaskRecord, socket?: WebSocket): Promise<boolean> {
    const targets = socket ? [socket] : this.ctx.getWebSockets(task.assignedNodeId || "");
    let sent = false;
    for (const sock of targets) {
      try {
        sock.send(JSON.stringify({
          type: "task",
          taskId: task.id,
          workload: task.workload,
          payload: task.payload,
          timeoutMs: task.timeoutMs,
        }));
        sent = true;
        break;
      } catch {}
    }
    return sent;
  }

  private async tryAssignAll() {
    const pendingIds = await this.getPending();
    if (pendingIds.length === 0) return;

    const idleNodes = await this.getIdleNodes();
    if (idleNodes.length === 0) return;

    let remainingIdle = [...idleNodes];

    for (const taskId of [...pendingIds]) {
      const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
      if (!task || task.status !== "pending") continue;

      let chosenNode: string | null = null;
      let bestLoad = Infinity;
      let bestConnectedAt = Infinity;

      for (const nodeId of remainingIdle) {
        const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
        if (!node || node.status !== "idle") continue;
        if (!node.capabilities.includes(task.workload as WorkloadType)) continue;
        // Never hand a heavy WASM workload to a low-memory / mobile node; the
        // model load would spike memory and get the device's process killed.
        if (node.lowMemory && HEAVY_WORKLOADS.has(task.workload)) continue;
        const sockets = this.ctx.getWebSockets(nodeId);
        if (sockets.length === 0) continue;

        if (
          node.cpuLoad < bestLoad ||
          (node.cpuLoad === bestLoad && node.connectedAt < bestConnectedAt)
        ) {
          chosenNode = nodeId;
          bestLoad = node.cpuLoad;
          bestConnectedAt = node.connectedAt;
        }
      }

      if (!chosenNode) break;

      task.status = "processing";
      task.assignedNodeId = chosenNode;
      task.assignedAt = Date.now();
      await this.ctx.storage.put(`task:${taskId}`, task);

      this.pendingCache = pendingIds.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:pending", this.pendingCache);

      const processing = await this.getProcessing();
      this.processingCache = processing;
      if (!this.processingCache.includes(taskId)) {
        this.processingCache.push(taskId);
      }
      await this.ctx.storage.put("queue:processing", this.processingCache);

      const node = await this.ctx.storage.get<NodeRecord>(`node:${chosenNode}`);
      if (node) {
        node.status = "busy";
        node.currentTaskId = taskId;
        await this.ctx.storage.put(`node:${chosenNode}`, node);
      }

      remainingIdle = remainingIdle.filter(id => id !== chosenNode);
      await this.ctx.storage.put("nodes:idle", remainingIdle);

      const sent = await this.deliverTask(task);

      // If the send failed, immediately fail the task (with retry) instead of
      // leaving it stuck in `processing`.
      if (!sent) {
        await this.failTask(taskId, "Failed to deliver task to node");
      }
    }
  }

  async alarm() {
    const now = Date.now();
    const processingIds = await this.getProcessing();

    for (const taskId of processingIds) {
      const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
      if (task && task.assignedAt && now - task.assignedAt > (task.timeoutMs || DEFAULT_TIMEOUT_MS)) {
        await this.failTask(taskId, "Task timed out");
      }
    }

    // Ping live nodes and garbage-collect stale ones (idle or busy).
    const idleNodes = await this.getIdleNodes();
    const nodeEntries = await this.ctx.storage.list({ prefix: "node:" });

    for (const [key, record] of nodeEntries) {
      const nodeId = key.slice("node:".length);
      const node = record as unknown as NodeRecord;

      if (now - node.lastPongAt > STALE_NODE_MS) {
        if (node.currentTaskId) {
          await this.failTask(node.currentTaskId, "Node stale", undefined, false);
        }
        await this.ctx.storage.delete(key);
        const idx = idleNodes.indexOf(nodeId);
        if (idx !== -1) idleNodes.splice(idx, 1);
        continue;
      }

      const sockets = this.ctx.getWebSockets(nodeId);
      for (const sock of sockets) {
        try {
          sock.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }
    }
    await this.ctx.storage.put("nodes:idle", idleNodes);

    // GC expired rate-limit entries.
    const rateEntries = await this.ctx.storage.list({ prefix: "rate:" });
    for (const [key, entry] of rateEntries) {
      const rate = entry as unknown as RateEntry;
      if (now > rate.resetAt) {
        await this.ctx.storage.delete(key);
      }
    }

    const pending = await this.getPending();
    const processing = await this.getProcessing();
    const remainingIdle = await this.getIdleNodes();
    if (pending.length > 0 || processing.length > 0 || remainingIdle.length > 0) {
      await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }

  // --- Rate limiting (storage-backed, shared across Worker isolates) ---

  private async checkRateLimit(request: Request, kind: string): Promise<boolean> {
    const maxStr = this.env.RATE_LIMIT_MAX || '100';
    const max = parseInt(maxStr, 10) || 100;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `rate:${kind}:${ip}`;
    const now = Date.now();

    const entry = await this.ctx.storage.get<RateEntry>(key);
    if (!entry || now > entry.resetAt) {
      await this.ctx.storage.put(key, { count: 1, resetAt: now + 60000 });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    await this.ctx.storage.put(key, entry);
    return true;
  }

  // --- Helpers ---

  private async getPending(): Promise<string[]> {
    if (this.pendingCache) return this.pendingCache;
    this.pendingCache = (await this.ctx.storage.get<string[]>("queue:pending")) || [];
    return this.pendingCache;
  }

  private async getProcessing(): Promise<string[]> {
    if (this.processingCache) return this.processingCache;
    this.processingCache = (await this.ctx.storage.get<string[]>("queue:processing")) || [];
    return this.processingCache;
  }

  private async getIdleNodes(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("nodes:idle")) || [];
  }
}
