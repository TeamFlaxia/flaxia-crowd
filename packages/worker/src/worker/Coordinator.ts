import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type {
  SwarmChainNode,
  SwarmInferencePayload,
  SwarmInitMessage,
  SwarmSessionPlan,
  TaskRecord,
  WarmModelRange,
  WorkloadType,
} from "@flaxia/sdk";
import {
  HEAVY_WORKLOADS,
  isValidSwarmChain,
  swarmChainIndex,
  swarmNextHopIndex,
  decodeSwarmEnvelope,
} from "@flaxia/sdk";
import { signPayload } from "../security";

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_RETRIES = 3;
export const STALE_NODE_MS = 60000;
export const ALARM_INTERVAL_MS = 30000;
/** How long a finished task stays readable through `GET /crowd/tasks/:id`. */
export const TASK_RETENTION_MS = 60 * 60 * 1000;
/** Callback delivery attempts, the first one included. */
export const CALLBACK_MAX_ATTEMPTS = 5;
/** Parked callbacks; past this the oldest one is dropped. */
export const CALLBACK_QUEUE_LIMIT = 500;
const CALLBACK_BACKOFF_BASE_MS = 5000;
const DEFAULT_MIN_SWARM_NODES = 1;
const DEFAULT_MAX_SWARM_NODES = 4;

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
  /** Measured WASM memory the device can commit; used as swarm split capacity. */
  wasmMemoryBytes?: number;
  /** WebGPU adapter is available; required for `swarm-inference`. */
  webgpu?: boolean;
  gpuArchitecture?: string;
  maxStorageBufferBindingSize?: number;
  /** Model layer spans already cached on the node. */
  warmModels?: WarmModelRange[];
}

/** Coordinator-side state for one swarm session, keyed by task id. */
interface SwarmRecord {
  sessionId: string;
  taskId: string;
  hostNodeId: string;
  members: Array<{ nodeId: string; capacity: number }>;
  ready: string[];
  plan?: SwarmSessionPlan;
  started?: boolean;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

/** One callback delivery waiting for its next attempt; parked in `queue:callbacks`. */
interface CallbackEntry {
  url: string;
  body: Record<string, unknown>;
  /** Attempts made so far, the initial delivery included. */
  attempts: number;
  nextAttemptAt: number;
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

    // Internal route: lets the worker layer reuse this limiter (and its
    // `rate:<kind>:<ip>` keys) for write routes that do not talk to the DO.
    if (url.pathname.startsWith("/rate-limit/")) {
      const kind = url.pathname.slice("/rate-limit/".length);
      if (!kind) return new Response("Not Found", { status: 404 });
      if (!(await this.checkRateLimit(request, kind))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return new Response(null, { status: 204 });
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
    const webgpu = url.searchParams.get("webgpu") === "true";
    const gpuArchitecture = url.searchParams.get("gpu") || undefined;
    const wasmRaw = url.searchParams.get("wasm");
    const wasmMemoryBytes = wasmRaw !== null && Number.isFinite(Number(wasmRaw)) ? Number(wasmRaw) : undefined;
    const maxBufferRaw = url.searchParams.get("maxBuffer");
    const maxStorageBufferBindingSize = maxBufferRaw !== null && Number.isFinite(Number(maxBufferRaw))
      ? Number(maxBufferRaw)
      : undefined;
    let warmModels: WarmModelRange[] | undefined;
    const warmRaw = url.searchParams.get("warmModels");
    if (warmRaw) {
      try {
        const parsed = JSON.parse(warmRaw);
        if (Array.isArray(parsed) && parsed.length > 0) warmModels = parsed as WarmModelRange[];
      } catch {}
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // If the node reconnects while a single-node task is still in flight, keep the task
    // assigned to this node and deliver it on the new socket. Failing and
    // requeueing here would redeliver the same task on every reconnect
    // (mobile / tab-switch flapping) and consume retry budget, so a single
    // task could be dispatched to the node many times in a short window.
    const existing = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    let resumeTask: TaskRecord | undefined;
    let restartSwarmTaskId: string | undefined;
    if (existing?.currentTaskId) {
      const inFlight = await this.ctx.storage.get<TaskRecord>(`task:${existing.currentTaskId}`);
      if (inFlight && inFlight.status === "processing") {
        const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${inFlight.id}`);
        if (swarm?.members.some(member => member.nodeId === nodeId)) {
          restartSwarmTaskId = inFlight.id;
          resumeTask = inFlight;
        } else if (inFlight.assignedNodeId === nodeId) {
          resumeTask = inFlight;
        }
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
      webgpu,
      gpuArchitecture,
      maxStorageBufferBindingSize,
      warmModels,
      wasmMemoryBytes,
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
    if (restartSwarmTaskId) {
      // A reconnect may have lost frames or worker state. Abort the entire
      // attempt on the replacement socket before issuing a fresh session.
      await this.failTask(restartSwarmTaskId, "Swarm member reconnected");
    } else if (resumeTask) {
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

    // A binary frame is a swarm hidden state: route it to the next chain hop
    // without decoding the payload.
    if (message instanceof ArrayBuffer) {
      await this.relaySwarmFrame(nodeId, message);
      return;
    }

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

      if (data.type === "swarm-plan") {
        await this.handleSwarmPlan(nodeId, data);
        return;
      }

      if (data.type === "swarm-ready") {
        await this.handleSwarmReady(nodeId, data.sessionId);
        return;
      }

      if (data.type === "result" || data.type === "error") {
        const isError = data.type === "error";
        const taskId = typeof data.taskId === "string" ? data.taskId : "";
        const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
        if (data.sessionId !== undefined && !swarm) return;
        if (swarm && (data.sessionId !== swarm.sessionId ||
          !swarm.members.some(member => member.nodeId === nodeId))) return;

        if (isError) {
          const error = typeof data.error === "string" ? data.error : "Node error";
          // A swarm member may fail at any position, so do not gate the failure
          // on the (host) assignedNodeId.
          await this.failTask(taskId, error, swarm ? undefined : nodeId);
        } else {
          // Worker results are ignored: completeTask only accepts the node that
          // matches assignedNodeId (the host). The host result is authoritative.
          await this.completeTask(taskId, data.payload, nodeId);
        }

        await this.tryAssignAll();
        return;
      }

      if (data.type === "progress") {
        const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
        if (!node || node.currentTaskId !== data.taskId) return;
        const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${node.currentTaskId}`);
        if (swarm && (data.sessionId !== swarm.sessionId || swarm.hostNodeId !== nodeId)) return;
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

  // --- Swarm session relay ---

  private sendToNode(nodeId: string, message: unknown, binary?: ArrayBuffer) {
    for (const sock of this.ctx.getWebSockets(nodeId)) {
      try {
        sock.send(binary ?? JSON.stringify(message));
      } catch {}
    }
  }

  private async relaySwarmFrame(nodeId: string, frame: ArrayBuffer) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = node?.currentTaskId;
    if (!taskId) return;
    const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    const plan = task?.swarmSession;
    if (!plan) return;
    const envelope = decodeSwarmEnvelope(frame);
    if (!envelope || envelope.sessionId !== plan.sessionId) return;

    const index = swarmChainIndex(plan, nodeId);
    if (index < 0) return;
    const next = plan.chain[swarmNextHopIndex(plan.chain.length, index)];
    if (!next) return;
    this.sendToNode(next.nodeId, null, frame);
  }

  /**
   * A plan the coordinator cannot accept must be reported back: silently
   * dropping it leaves every member `busy` and the session wedged until the
   * task timeout. Tell the host (which is running the session) and fail the
   * task so its members are released and the failure reaches the caller.
   */
  private async rejectSwarmPlan(taskId: string, sessionId: string, nodeId: string, reason: string) {
    this.sendToNode(nodeId, { type: "swarm-error", sessionId, taskId, error: reason });
    // The plan is derived from the model metadata, so the same host would
    // produce the same broken chain again: fail for good rather than burning
    // retries (and leave no window for a retry to start a second session).
    await this.failTask(taskId, reason, undefined, true, true);
    await this.tryAssignAll();
  }

  private async handleSwarmPlan(nodeId: string, data: Record<string, unknown>) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = node?.currentTaskId;
    if (!taskId) return;

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (!swarm) return;
    if (data.sessionId !== swarm.sessionId) return;
    if (swarm.hostNodeId !== nodeId) {
      await this.rejectSwarmPlan(taskId, swarm.sessionId, nodeId, "swarm plan was sent by a node that is not the host");
      return;
    }
    if (swarm.plan) return;

    const chain = data.chain as SwarmChainNode[] | undefined;
    if (!isValidSwarmChain(chain)) {
      await this.rejectSwarmPlan(taskId, swarm.sessionId, nodeId, "swarm plan is not a valid contiguous layer chain");
      return;
    }

    // The host is authoritative for placement, but every member must appear.
    const plannedIds = new Set(chain.map((c) => c.nodeId));
    if (plannedIds.size !== swarm.members.length || !swarm.members.every((m) => plannedIds.has(m.nodeId))) {
      await this.rejectSwarmPlan(taskId, swarm.sessionId, nodeId, "swarm plan does not cover every member");
      return;
    }

    const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    if (!task) return;

    const layers = chain[chain.length - 1].slice.end;
    const plan: SwarmSessionPlan = {
      sessionId: swarm.sessionId,
      taskId,
      model: (task.payload as SwarmInferencePayload)?.model ?? "",
      layers,
      chain,
    };
    task.swarmSession = plan;
    await this.ctx.storage.put(`task:${taskId}`, task);

    swarm.plan = plan;
    await this.ctx.storage.put(`swarm:${taskId}`, swarm);

    for (let i = 0; i < chain.length; i++) {
      this.sendToNode(chain[i].nodeId, {
        type: "swarm-slice",
        sessionId: swarm.sessionId,
        taskId,
        model: (task.payload as SwarmInferencePayload)?.model ?? "",
        timeoutMs: task.timeoutMs,
        index: i,
        chainLength: chain.length,
        role: chain[i].role,
        slice: chain[i].slice,
      });
    }
  }

  private async handleSwarmReady(nodeId: string, sessionId: unknown) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = node?.currentTaskId;
    if (!taskId) return;

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (!swarm || !swarm.plan || swarm.started) return;
    if (sessionId !== swarm.sessionId) return;
    if (!swarm.members.some((m) => m.nodeId === nodeId)) return;

    if (!swarm.ready.includes(nodeId)) swarm.ready.push(nodeId);
    if (swarm.ready.length >= swarm.members.length) {
      swarm.started = true;
      await this.ctx.storage.put(`swarm:${taskId}`, swarm);
      this.sendToNode(swarm.hostNodeId, { type: "swarm-start", sessionId: swarm.sessionId, taskId });
    } else {
      await this.ctx.storage.put(`swarm:${taskId}`, swarm);
    }
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
    // The session is over: drop the chain so `relaySwarmFrame` cannot keep
    // routing on it (and a retry never inherits a previous attempt's plan).
    task.swarmSession = undefined;
    await this.ctx.storage.put(`task:${taskId}`, task);

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (swarm) {
      await this.releaseSwarmMembers(taskId);
    } else {
      await this.releaseNode(nodeId);
    }

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

  /**
   * Fail a task. Transient failures (timeout, disconnect) are retried up to
   * MAX_RETRIES; `permanent` is for protocol violations that would fail the same
   * way on every attempt, so they are reported to the caller immediately.
   */
  private async failTask(taskId: string, error: string, expectedNodeId?: string, release = true, permanent = false) {
    const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
    if (!task || (task.status !== "pending" && task.status !== "processing")) return;
    if (expectedNodeId && task.assignedNodeId && task.assignedNodeId !== expectedNodeId) return;

    // The session ends here either way (retry or failure): a stale chain must
    // not survive to route a later attempt's frames.
    task.swarmSession = undefined;

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    // The session ends here either way, so every node still working on it must
    // be told: without a stop signal a member whose peer failed sits idle until
    // the task timeout, holding a slot the scheduler is still counting as busy.
    // The receiver does not echo an error back (see AbortMessage), so a task
    // requeued for retry below cannot be knocked over by its own members.
    const running = swarm
      ? swarm.members.map(member => member.nodeId)
      : task.assignedNodeId
        ? [task.assignedNodeId]
        : [];
    for (const nodeId of running) {
      this.sendToNode(nodeId, { type: "abort", taskId, sessionId: swarm?.sessionId, error });
    }
    if (swarm) {
      await this.releaseSwarmMembers(taskId);
    } else if (task.assignedNodeId && release) {
      await this.releaseNode(task.assignedNodeId);
    }

    // Retry transient failures (timeout / disconnect) up to MAX_RETRIES times.
    // Keyed on retryCount (not status) so a task that was already requeued by
    // an earlier failure keeps its remaining retries instead of being
    // permanently failed by a second overlapping failure signal.
    if (!permanent && task.retryCount < MAX_RETRIES) {
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

  private async releaseSwarmMembers(taskId: string) {
    const record = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (!record) return;
    for (const member of record.members) {
      const node = await this.ctx.storage.get<NodeRecord>(`node:${member.nodeId}`);
      if (node?.currentTaskId === taskId) {
        await this.releaseNode(member.nodeId);
      }
    }
    await this.ctx.storage.delete(`swarm:${taskId}`);
  }

  /**
   * Deliver a task callback. A delivery the receiver did not accept is parked
   * in `queue:callbacks` and retried by the alarm: the verdict is the whole
   * point of the callback, and the task record itself is collected after
   * `TASK_RETENTION_MS`, so a dropped response is lost for good.
   */
  private async deliverCallback(url: string, body: Record<string, unknown>) {
    if (await this.postCallback(url, body)) return;

    const entry: CallbackEntry = {
      url,
      body,
      attempts: 1,
      nextAttemptAt: Date.now() + CALLBACK_BACKOFF_BASE_MS,
    };
    const id = crypto.randomUUID();
    const queue = (await this.ctx.storage.get<string[]>("queue:callbacks")) || [];
    queue.push(id);
    // A caller that stopped listening must not pin storage (and the alarm)
    // forever: past the limit the oldest waiting callback is dropped.
    while (queue.length > CALLBACK_QUEUE_LIMIT) {
      const dropped = queue.shift() as string;
      await this.ctx.storage.delete(`callback:${dropped}`);
      console.warn(`[coordinator] dropped callback ${dropped}: retry queue is full (${CALLBACK_QUEUE_LIMIT})`);
    }
    await this.ctx.storage.put(`callback:${id}`, entry);
    await this.ctx.storage.put("queue:callbacks", queue);

    // The alarm may have stopped already (the task settled outside a previous
    // wake-up); make sure the retry is not waiting on one that never comes.
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > entry.nextAttemptAt) {
      await this.ctx.storage.setAlarm(entry.nextAttemptAt);
    }
  }

  /** Single callback POST; true when the receiver accepted it (2xx). */
  private async postCallback(url: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      const payload = JSON.stringify(body);
      const signature = this.env.NODE_TOKEN_SECRET
        ? await signPayload(this.env.NODE_TOKEN_SECRET, payload)
        : '';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(signature ? { 'X-Flaxia-Signature': signature } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Retry parked callbacks whose backoff has elapsed. Returns true while any
   * entry is still waiting, so the alarm knows to come back.
   */
  private async retryQueuedCallbacks(now: number): Promise<boolean> {
    const queue = (await this.ctx.storage.get<string[]>("queue:callbacks")) || [];
    if (queue.length === 0) return false;

    const remaining: string[] = [];
    for (const id of queue) {
      const key = `callback:${id}`;
      const entry = await this.ctx.storage.get<CallbackEntry>(key);
      if (!entry) continue;
      if (now < entry.nextAttemptAt) {
        remaining.push(id);
        continue;
      }

      if (await this.postCallback(entry.url, entry.body)) {
        await this.ctx.storage.delete(key);
        continue;
      }

      entry.attempts++;
      if (entry.attempts >= CALLBACK_MAX_ATTEMPTS) {
        console.error(
          `[coordinator] callback for task ${String(entry.body.taskId)} failed after ${entry.attempts} attempts`,
          entry.url,
        );
        await this.ctx.storage.delete(key);
        continue;
      }

      entry.nextAttemptAt = now + CALLBACK_BACKOFF_BASE_MS * 2 ** (entry.attempts - 1);
      await this.ctx.storage.put(key, entry);
      remaining.push(id);
    }

    if (remaining.length !== queue.length) {
      await this.ctx.storage.put("queue:callbacks", remaining);
    }
    return remaining.length > 0;
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

      if (task.workload === "swarm-inference") {
        const chosen = await this.tryAssignSwarm(taskId, task, remainingIdle);
        if (chosen) {
          remainingIdle = remainingIdle.filter(id => !chosen.includes(id));
          await this.ctx.storage.put("nodes:idle", remainingIdle);
        }
        continue;
      }

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

      if (!chosenNode) continue;

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

  /**
   * Reserve a group of WebGPU nodes for a swarm session and hand the host the
   * member list. Slices are planned by the host (it owns the model metadata);
   * the coordinator only brokers resources and relays frames.
   */
  private async tryAssignSwarm(taskId: string, task: TaskRecord, idle: string[]): Promise<string[] | null> {
    const payload = task.payload as SwarmInferencePayload;
    const opts = payload?.swarm ?? {};
    // `payload` is unvalidated API input: `Math.floor("abc")` is NaN, and NaN
    // silently defeats both the availability check and `slice(0, ...)`. Anything
    // that is not a usable count falls back to the default instead of wedging
    // the scheduler (or the task) on a bad payload.
    const asCount = (value: unknown, fallback: number): number => {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
    };
    const minNodes = asCount(opts.minNodes, DEFAULT_MIN_SWARM_NODES);
    const maxNodes = Math.max(minNodes, asCount(opts.maxNodes, DEFAULT_MAX_SWARM_NODES));

    const eligible: NodeRecord[] = [];
    for (const nodeId of idle) {
      const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
      if (!node || node.status !== "idle") continue;
      if (!node.capabilities.includes("swarm-inference")) continue;
      if (!node.webgpu) continue;
      if (node.lowMemory) continue;
      if (this.ctx.getWebSockets(nodeId).length === 0) continue;
      eligible.push(node);
    }
    if (eligible.length < minNodes) return null;

    // Warm first, then strongest devices: a node that already holds the model's
    // byte ranges skips the range download entirely, which dominates the load
    // time on crowd links. `preferWarm` defaults to true; the capacity ordering
    // still decides the host within each group (index 0 runs embedding, head,
    // sampling).
    const preferWarm = opts.preferWarm !== false;
    const wantedModel = typeof payload?.model === "string" ? payload.model : "";
    const isWarm = (n: NodeRecord) =>
      !!n.warmModels?.some((m) => m.modelId === wantedModel);
    eligible.sort(
      (a, b) =>
        (preferWarm ? Number(isWarm(b)) - Number(isWarm(a)) : 0) ||
        (b.wasmMemoryBytes ?? b.maxStorageBufferBindingSize ?? 0) -
          (a.wasmMemoryBytes ?? a.maxStorageBufferBindingSize ?? 0) ||
        a.connectedAt - b.connectedAt,
    );
    const chosen = eligible.slice(0, Math.min(maxNodes, eligible.length));
    if (chosen.length === 0) return null;
    const host = chosen[0];
    const sessionId = crypto.randomUUID();
    const members = chosen.map((n) => ({
      nodeId: n.id,
      capacity: n.wasmMemoryBytes ?? n.maxStorageBufferBindingSize ?? 1,
    }));

    task.status = "processing";
    task.assignedNodeId = host.id;
    task.assignedAt = Date.now();
    await this.ctx.storage.put(`task:${taskId}`, task);

    this.pendingCache = (await this.getPending()).filter(id => id !== taskId);
    await this.ctx.storage.put("queue:pending", this.pendingCache);
    const processing = await this.getProcessing();
    if (!processing.includes(taskId)) processing.push(taskId);
    this.processingCache = processing;
    await this.ctx.storage.put("queue:processing", processing);

    for (const n of chosen) {
      n.status = "busy";
      n.currentTaskId = taskId;
      await this.ctx.storage.put(`node:${n.id}`, n);
    }

    const record: SwarmRecord = {
      sessionId,
      taskId,
      hostNodeId: host.id,
      members,
      ready: [],
    };
    await this.ctx.storage.put(`swarm:${taskId}`, record);

    const init: SwarmInitMessage = {
      type: "swarm-init",
      sessionId,
      taskId,
      model: payload?.model ?? "",
      timeoutMs: task.timeoutMs,
      members,
      prompt: payload?.prompt ?? "",
      maxNewTokens: payload?.maxNewTokens,
    };
    this.sendToNode(host.id, init);

    return chosen.map(n => n.id);
  }

  /**
   * Settle every queued task whose deadline has passed. A `processing` task is
   * retried (its node may just be slow); a `pending` task nobody ever took can
   * only fail for good, and without this it would stay queued — and keep the
   * alarm armed — forever.
   */
  private async expireOverdueTasks(now: number) {
    const processingIds = await this.getProcessing();

    for (const taskId of processingIds) {
      const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
      if (task && task.assignedAt && now - task.assignedAt > (task.timeoutMs || DEFAULT_TIMEOUT_MS)) {
        await this.failTask(taskId, "Task timed out");
      }
    }

    const pendingIds = await this.getPending();
    for (const taskId of pendingIds) {
      const task = await this.ctx.storage.get<TaskRecord>(`task:${taskId}`);
      if (!task || task.status !== "pending") continue;
      // A task requeued after a failed attempt keeps its `createdAt`, so it is
      // allowed one timeout window per attempt — otherwise the same alarm pass
      // that requeues a timed-out task would fail it again on the spot and no
      // retry would ever run.
      const budget = (task.timeoutMs || DEFAULT_TIMEOUT_MS) * (task.retryCount + 1);
      if (now - task.createdAt > budget) {
        await this.failTask(taskId, "task_timeout_unassigned", undefined, true, true);
      }
    }
  }

  /**
   * Delete finished tasks whose caller has had `TASK_RETENTION_MS` to read
   * them. Returns true while any record is still retained, so the alarm knows
   * to come back for it.
   */
  private async pruneSettledTasks(now: number): Promise<boolean> {
    const entries = await this.ctx.storage.list<TaskRecord>({ prefix: "task:" });

    let retained = false;
    for (const [key, task] of entries) {
      if (task.status !== "done" && task.status !== "failed") continue;
      if (now - (task.completedAt ?? task.createdAt) > TASK_RETENTION_MS) {
        await this.ctx.storage.delete(key);
      } else {
        retained = true;
      }
    }
    return retained;
  }

  async alarm() {
    const now = Date.now();
    await this.expireOverdueTasks(now);

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

    // Keep the alarm alive only while there is something left to do: a queued
    // task, a live node to ping, a callback waiting for its retry, or a
    // finished task still inside its retention window.
    const pendingCallbacks = await this.retryQueuedCallbacks(now);
    const retainedTasks = await this.pruneSettledTasks(now);

    const pending = await this.getPending();
    const processing = await this.getProcessing();
    const remainingIdle = await this.getIdleNodes();
    if (
      pending.length > 0 ||
      processing.length > 0 ||
      remainingIdle.length > 0 ||
      pendingCallbacks ||
      retainedTasks
    ) {
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
