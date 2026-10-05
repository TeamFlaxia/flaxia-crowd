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
  MIN_SWARM_NODES,
  MAX_SWARM_NODES,
} from "@flaxia/sdk";
import { clampByteCapacity, createSwarmHopKey, createWebhookSignature, validateCallbackUrl } from "../security";
import { parseWarmModels } from "../crowd";

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_RETRIES = 3;
export const STALE_NODE_MS = 60000;
export const ALARM_INTERVAL_MS = 30000;
const DEFAULT_MIN_SWARM_NODES = MIN_SWARM_NODES;
const DEFAULT_MAX_SWARM_NODES = 4;
/**
 * A swarm needs at least this many distinct eligible nodes. One node is never a
 * swarm: it would own the whole model, so it could both see every payload and
 * unilaterally produce the result.
 */
const MIN_SWARM_CANDIDATES = 2;

// --- Queue, fan-out and payload caps (DoS bounds) ---

/** Hard cap on the global pending queue; further enqueues get a 429. */
export const MAX_PENDING_TASKS = 500;
/** Hard cap on one tenant's pending tasks. */
export const MAX_PENDING_TASKS_PER_TENANT = 50;
/** Enqueues accepted per tenant per minute. */
export const MAX_ENQUEUE_PER_MINUTE = 60;
/**
 * A task that no eligible node picked up is failed after this long instead of
 * living in the queue forever.
 */
export const MAX_PENDING_TTL_MS = 5 * 60 * 1000;
/** Concurrent `/crowd/subscribe` sockets per task. */
export const MAX_SUBSCRIBERS_PER_TASK = 8;
/** Subscribe upgrades accepted per task per minute. */
export const MAX_SUBSCRIBE_PER_MINUTE = 30;
/** Pending tasks examined per scheduling pass (bounds DO work per invocation). */
export const MAX_ASSIGN_PER_PASS = 32;
/** Serialized result ceiling; a larger payload is dropped, not settled. */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;
/** Progress token ceiling (#21) and per-task send rate. */
export const MAX_PROGRESS_TOKEN_CHARS = 4096;
export const MAX_PROGRESS_PER_SECOND = 50;

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
  /** Site id from the signed node token; never from a request body. */
  siteId?: string;
  /** Measured WASM memory the device can commit; used as swarm split capacity. */
  wasmMemoryBytes?: number;
  /** WebGPU adapter is available; required for `swarm-inference`. */
  webgpu?: boolean;
  gpuArchitecture?: string;
  maxStorageBufferBindingSize?: number;
  /** Model layer spans already cached on the node. */
  warmModels?: WarmModelRange[];
  /** Tasks handed to this node so far, used as a fairness tie-break. */
  assignedCount?: number;
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

/**
 * The delivery attempt currently allowed to settle a task. `attemptId` is
 * regenerated on every delivery and retired when the attempt ends, so a late
 * message from a previous attempt (or a forged one) changes nothing.
 */
interface AttemptRecord {
  attemptId: string;
  nodeId: string;
  tenantId: string;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

/**
 * A result is accepted only when it is a plain object within the size cap.
 * Malformed or oversized payloads are dropped without settling the task: an
 * attacker must not be able to fail (or complete) a task by sending garbage.
 */
export function validateResultPayload(result: unknown): { ok: true } | { ok: false; reason: string } {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, reason: "result must be an object" };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    return { ok: false, reason: "result is not serializable" };
  }
  if (serialized === undefined) return { ok: false, reason: "result is not serializable" };
  // Character count, not bytes: UTF-16 code units bound the serialized form
  // within a factor of two, which is enough for a DoS ceiling.
  if (serialized.length > MAX_RESULT_BYTES) return { ok: false, reason: "result is too large" };
  return { ok: true };
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
      if (!(await this.checkIpRateLimit(request, "signal"))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return this.handleWebSocket(request, url);
    }

    if (url.pathname === "/subscribe") {
      if (!(await this.checkIpRateLimit(request, "subscribe"))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return this.handleSubscribe(request, url);
    }

    if (url.pathname === "/enqueue") {
      return this.handleEnqueue(request);
    }

    // `/task/<tenantId>/<taskId>`: the tenant is part of the key, so a caller
    // can only ever address a task inside its own tenant namespace.
    if (url.pathname.startsWith("/task/")) {
      const parts = url.pathname.slice("/task/".length).split("/").map(decodeURIComponent);
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return new Response("Not found", { status: 404 });
      }
      const task = await this.getTask(parts[1], parts[0]);
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
    // Site identity comes from the signed token (via the worker), never from a
    // request body, so a node cannot claim to be a site it is not.
    const siteId = url.searchParams.get("site") || undefined;
    const wasmRaw = url.searchParams.get("wasm");
    const wasmMemoryBytes = clampByteCapacity(wasmRaw === null ? undefined : Number(wasmRaw));
    const maxBufferRaw = url.searchParams.get("maxBuffer");
    const maxStorageBufferBindingSize = clampByteCapacity(maxBufferRaw === null ? undefined : Number(maxBufferRaw));
    let warmModels: WarmModelRange[] | undefined;
    const warmRaw = url.searchParams.get("warmModels");
    if (warmRaw) {
      try {
        warmModels = parseWarmModels(JSON.parse(warmRaw));
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
      const inFlight = await this.getTask(existing.currentTaskId);
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

    // The worker only forwards a connection after verifying a signed token that
    // is bound to this exact node id, so a socket already live for this identity
    // belongs to the same node (a reconnect) and is closed only now that the
    // token is proven. An attacker cannot obtain a token for someone else's id:
    // `/crowd/nodes/register` ignores client-supplied ids.
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
      siteId,
      webgpu,
      gpuArchitecture,
      maxStorageBufferBindingSize,
      warmModels,
      wasmMemoryBytes,
      assignedCount: existing?.assignedCount ?? 0,
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
          // The load is self-reported, so only accept a well-formed value: a
          // malformed one must not silently become the best possible score.
          const rawLoad = data.cpuLoad;
          if (typeof rawLoad === "number" && Number.isFinite(rawLoad)) {
            node.cpuLoad = Math.min(1, Math.max(0, rawLoad));
          }
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

      if (data.type === "result" || data.type === "error" || data.type === "swarm-error") {
        await this.handleSettlement(ws, nodeId, data);
        return;
      }

      if (data.type === "progress" || data.type === "swarm-token") {
        await this.handleProgress(ws, nodeId, data);
        return;
      }

      if (data.type === "swarm-done") {
        await this.handleSwarmDone(ws, nodeId, data);
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

  /**
   * Deliver a control message that starts a new attempt: the socket that
   * receives it is tagged with the attempt id, so only messages arriving back
   * on this socket can settle the attempt.
   */
  private sendAttemptToNode(nodeId: string, message: object, attemptId: string): boolean {
    for (const sock of this.ctx.getWebSockets(nodeId)) {
      try {
        sock.send(JSON.stringify({ ...message, attemptId }));
      } catch {
        continue;
      }
      try { sock.serializeAttachment({ attemptId }); } catch {}
      return true;
    }
    return false;
  }

  private async recordAttempt(taskId: string, nodeId: string, tenantId: string, attemptId: string) {
    await this.ctx.storage.put(`attempt:${taskId}`, { attemptId, nodeId, tenantId } satisfies AttemptRecord);
  }

  private async retireAttempt(taskId: string) {
    await this.ctx.storage.delete(`attempt:${taskId}`);
  }

  /**
   * Accept a message from a node only when it carries the current attempt id
   * AND arrived on the socket that received that delivery. Returns the attempt
   * id, or null when the message must be ignored (no state change at all).
   */
  private async acceptAttempt(
    ws: WebSocket,
    taskId: string,
    nodeId: string,
    rawAttemptId: unknown,
  ): Promise<string | null> {
    if (typeof rawAttemptId !== "string" || !rawAttemptId) return null;
    const attempt = await this.ctx.storage.get<AttemptRecord>(`attempt:${taskId}`);
    if (!attempt || attempt.attemptId !== rawAttemptId || attempt.nodeId !== nodeId) return null;
    let attachment: { attemptId?: string } | undefined;
    try {
      attachment = ws.deserializeAttachment() as { attemptId?: string } | undefined;
    } catch {
      attachment = undefined;
    }
    if (attachment?.attemptId !== attempt.attemptId) return null;
    return attempt.attemptId;
  }

  private async relaySwarmFrame(nodeId: string, frame: ArrayBuffer) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = node?.currentTaskId;
    if (!taskId) return;
    const task = await this.getTask(taskId);
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
    // `isValidSwarmChain` also enforces the layer bounds: non-negative integer
    // slices, at most MAX_SWARM_LAYERS total and MAX_SWARM_SLICE_LAYERS per
    // node. Without them a host could hand a volunteer `end: 1e9` and OOM it.
    if (!isValidSwarmChain(chain)) {
      await this.rejectSwarmPlan(
        taskId,
        swarm.sessionId,
        nodeId,
        "swarm plan is not a valid contiguous layer chain within the accepted layer bounds",
      );
      return;
    }

    // The host is authoritative for placement, but every member must appear.
    const plannedIds = new Set(chain.map((c) => c.nodeId));
    if (plannedIds.size !== swarm.members.length || !swarm.members.every((m) => plannedIds.has(m.nodeId))) {
      await this.rejectSwarmPlan(taskId, swarm.sessionId, nodeId, "swarm plan does not cover every member");
      return;
    }

    const task = await this.getTask(taskId);
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
    await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);

    swarm.plan = plan;
    await this.ctx.storage.put(`swarm:${taskId}`, swarm);

    // One key per hop edge: member i signs what it forwards with edge i's key
    // and verifies what it receives with edge (i-1)'s key. A member therefore
    // cannot inject or rewrite a frame as another hop, and the coordinator only
    // relays opaque bytes (it never holds a key).
    const hopKeys = chain.map(() => createSwarmHopKey());
    for (let i = 0; i < chain.length; i++) {
      const inboundKey = chain.length > 1 ? hopKeys[(i - 1 + chain.length) % chain.length] : undefined;
      const outboundKey = chain.length > 1 ? hopKeys[i] : undefined;
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
        inboundKey,
        outboundKey,
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

  /**
   * Settle a task from a node message (`result` / `error` / `swarm-error`).
   *
   * Session messages are host-authoritative: a member may not complete or fail
   * the task. A member's failure is relayed to the host, which owns the session
   * and decides whether to abort it — otherwise any member could grief every
   * other member's task.
   */
  private async handleSettlement(ws: WebSocket, nodeId: string, data: Record<string, unknown>) {
    const taskId = typeof data.taskId === "string" ? data.taskId : "";
    if (!taskId) return;
    const isError = data.type !== "result";
    const error = typeof data.error === "string" ? data.error : "Node error";

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    // A session id on a task with no live session is a stale attempt.
    if (data.sessionId !== undefined && !swarm) return;
    if (swarm) {
      if (data.sessionId !== swarm.sessionId) return;
      if (!swarm.members.some(member => member.nodeId === nodeId)) return;
      if (nodeId !== swarm.hostNodeId) {
        if (isError) {
          this.sendToNode(swarm.hostNodeId, {
            type: "swarm-error",
            sessionId: swarm.sessionId,
            taskId,
            error,
            fromNodeId: nodeId,
          });
        }
        return;
      }
    }

    const attemptId = await this.acceptAttempt(ws, taskId, nodeId, data.attemptId);
    if (!attemptId) return;

    if (isError) {
      await this.failTask(taskId, error, nodeId);
    } else {
      // Worker results are ignored: completeTask only accepts the node that
      // matches assignedNodeId (the host). The host result is authoritative.
      await this.completeTask(taskId, data.payload, nodeId, attemptId);
    }

    await this.tryAssignAll();
  }

  /**
   * Relay a progress token to subscribers (#21). Only the node that currently
   * owns the task and holds the current attempt may stream, the token has a hard
   * length cap, and each task has a send-rate limit; violations are dropped
   * rather than forwarded.
   */
  private async handleProgress(ws: WebSocket, nodeId: string, data: Record<string, unknown>) {
    const token = data.token;
    if (typeof token !== "string" || token.length > MAX_PROGRESS_TOKEN_CHARS) return;

    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = typeof data.taskId === "string" && data.taskId
      ? data.taskId
      : node?.currentTaskId;
    if (!taskId || !node || node.currentTaskId !== taskId) return;

    const task = await this.getTask(taskId);
    if (!task || task.assignedNodeId !== nodeId) return;

    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (swarm) {
      if (data.sessionId !== swarm.sessionId || swarm.hostNodeId !== nodeId) return;
    }

    if (!(await this.acceptAttempt(ws, taskId, nodeId, data.attemptId))) return;
    if (!(await this.checkRateLimitKey(`rate:progress:${taskId}`, MAX_PROGRESS_PER_SECOND, 1000))) return;

    const subs = this.ctx.getWebSockets(`client:${taskId}`);
    const msg = JSON.stringify({ type: "token", token });
    for (const sub of subs) {
      try { sub.send(msg); } catch {}
    }
  }

  /**
   * `swarm-done` marks the end of the host's generation loop. The task is only
   * settled by the host's `result` (which carries the payload), so this is
   * validated and ignored: accepting it from a member would let any member
   * declare another member's session finished.
   */
  private async handleSwarmDone(ws: WebSocket, nodeId: string, data: Record<string, unknown>) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const taskId = node?.currentTaskId;
    if (!taskId) return;
    const swarm = await this.ctx.storage.get<SwarmRecord>(`swarm:${taskId}`);
    if (!swarm) return;
    if (data.sessionId !== swarm.sessionId || swarm.hostNodeId !== nodeId) return;
    await this.acceptAttempt(ws, taskId, nodeId, data.attemptId);
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
    const tenantId = url.searchParams.get("tenantId");
    if (!taskId) return new Response("taskId is required", { status: 400 });
    // Set by the worker from the verified subscribe token, never by the client.
    if (!tenantId) return new Response("tenantId is required", { status: 400 });

    const existing = await this.getTask(taskId, tenantId);
    if (!existing) return new Response("Task not found", { status: 404 });

    // Fan-out cap: a known task id must not turn into unbounded replication.
    if (this.ctx.getWebSockets(`client:${taskId}`).length >= MAX_SUBSCRIBERS_PER_TASK) {
      return new Response("Too many subscribers for this task", { status: 429 });
    }
    if (!(await this.checkRateLimitKey(`rate:subscribe:${taskId}`, MAX_SUBSCRIBE_PER_MINUTE))) {
      return new Response("Rate limit exceeded", { status: 429 });
    }

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
    if (typeof body.tenantId !== "string" || !body.tenantId || body.tenantId.length > 128) {
      return Response.json({ error: "Task tenantId is required" }, { status: 400 });
    }
    // Fail closed rather than deliver an unsigned (forgeable) webhook.
    if (body.callbackUrl && !this.env.WEBHOOK_SIGNING_SECRET) {
      return Response.json({ error: "Webhook signing is not configured" }, { status: 400 });
    }

    const pending = await this.getPending();
    if (pending.length >= MAX_PENDING_TASKS) {
      return Response.json({ error: "Task queue is full" }, { status: 429 });
    }
    const tenantPending = await this.getTenantPending(body.tenantId);
    if (tenantPending.length >= MAX_PENDING_TASKS_PER_TENANT) {
      return Response.json({ error: "Tenant pending-task limit reached" }, { status: 429 });
    }
    if (!(await this.checkRateLimitKey(`rate:enqueue:${body.tenantId}`, MAX_ENQUEUE_PER_MINUTE))) {
      return Response.json({ error: "Enqueue rate limit exceeded" }, { status: 429 });
    }

    await this.ctx.storage.put(this.taskKey(body.tenantId, body.id), body);
    // Global task id -> tenant, so node messages can resolve their task without
    // the node having to know (or assert) a tenant id.
    await this.ctx.storage.put(`taskindex:${body.id}`, body.tenantId);

    pending.push(body.id);
    this.pendingCache = pending;
    await this.ctx.storage.put("queue:pending", pending);
    tenantPending.push(body.id);
    await this.putTenantPending(body.tenantId, tenantPending);

    await this.tryAssignAll();

    const alarm = await this.ctx.storage.getAlarm();
    // Wake up for the earliest deadline that matters: the task timeout, or the
    // pending TTL when that is sooner (a task nobody can serve must not sit in
    // the queue for a full hour just because it asked for a long timeout).
    const sweepAt = Date.now() + Math.min(body.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_PENDING_TTL_MS);
    if (!alarm || alarm > sweepAt) {
      await this.ctx.storage.setAlarm(sweepAt);
    }

    return Response.json({ message: "Task submitted", taskId: body.id });
  }

  private async completeTask(taskId: string, result: unknown, nodeId: string, attemptId: string) {
    const task = await this.getTask(taskId);
    if (!task || task.status !== "processing") return;
    if (task.assignedNodeId !== nodeId) return;
    // A malformed or oversized result is dropped: the task stays processing
    // (and will time out) instead of being settled with attacker-chosen data.
    if (!validateResultPayload(result).ok) return;

    task.status = "done";
    task.result = result;
    task.resultNodeId = nodeId;
    task.resultAttemptId = attemptId;
    task.completedAt = Date.now();
    // The session is over: drop the chain so `relaySwarmFrame` cannot keep
    // routing on it (and a retry never inherits a previous attempt's plan).
    task.swarmSession = undefined;
    await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);
    await this.retireAttempt(taskId);
    await this.removeFromTenantPending(task.tenantId, taskId);

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
        taskId,
        status: 'done',
        result: task.result,
        // Audit trail: the signature attests delivery, so the receiver must be
        // able to record which node and which attempt produced the value.
        nodeId: task.resultNodeId,
        attemptId: task.resultAttemptId,
      });
    }
  }

  /**
   * Fail a task. Transient failures (timeout, disconnect) are retried up to
   * MAX_RETRIES; `permanent` is for protocol violations that would fail the same
   * way on every attempt, so they are reported to the caller immediately.
   */
  private async failTask(taskId: string, error: string, expectedNodeId?: string, release = true, permanent = false) {
    const task = await this.getTask(taskId);
    if (!task || (task.status !== "pending" && task.status !== "processing")) return;
    if (expectedNodeId && task.assignedNodeId && task.assignedNodeId !== expectedNodeId) return;

    // The session ends here either way (retry or failure): a stale chain must
    // not survive to route a later attempt's frames, and a retired attempt must
    // not be able to settle the task after this point.
    task.swarmSession = undefined;
    await this.retireAttempt(taskId);

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
      await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);

      const processing = await this.getProcessing();
      this.processingCache = processing.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:processing", this.processingCache);

      const pending = await this.getPending();
      if (!pending.includes(taskId)) {
        pending.push(taskId);
        this.pendingCache = pending;
        await this.ctx.storage.put("queue:pending", pending);
      }
      const tenantPending = await this.getTenantPending(task.tenantId);
      if (!tenantPending.includes(taskId)) {
        tenantPending.push(taskId);
        await this.putTenantPending(task.tenantId, tenantPending);
      }
      return;
    }

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);

    if (task.assignedNodeId) {
      const processing = await this.getProcessing();
      this.processingCache = processing.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:processing", this.processingCache);
    } else {
      const pending = await this.getPending();
      this.pendingCache = pending.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:pending", this.pendingCache);
    }
    await this.removeFromTenantPending(task.tenantId, taskId);

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

  private async deliverCallback(url: string, body: Record<string, unknown>) {
    // Tasks with a callbackUrl are rejected at submit time when the secret is
    // missing; the guard stays so a misconfigured deployment can never deliver
    // an unsigned webhook that a receiver would have to trust blindly.
    const secret = this.env.WEBHOOK_SIGNING_SECRET;
    if (!secret) return;
    // Revalidate persisted URLs; never follow a webhook response to a new host
    // or scheme, otherwise a public HTTPS endpoint can redirect the signed POST
    // into a private network address despite the submit-time check.
    const safeUrl = validateCallbackUrl(url);
    if (!safeUrl) return;
    try {
      const payload = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = crypto.randomUUID();
      const signature = await createWebhookSignature(secret, timestamp, nonce, payload);
      await fetch(safeUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'X-Flaxia-Signature': signature,
          'X-Flaxia-Timestamp': timestamp,
          'X-Flaxia-Nonce': nonce,
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      // Callback failure is non-critical; task result remains available via REST API.
      console.warn('Webhook delivery failed:', error);
    }
  }

  /**
   * Deliver a task on a fresh attempt. Every delivery (including a resume after
   * reconnect) gets a new attempt id, and only the receiving socket is allowed
   * to settle it, so a replayed or forged result cannot complete the task.
   */
  private async deliverTask(task: TaskRecord, socket?: WebSocket): Promise<boolean> {
    if (!task.assignedNodeId) return false;
    const attemptId = crypto.randomUUID();
    const message = JSON.stringify({
      type: "task",
      taskId: task.id,
      workload: task.workload,
      payload: task.payload,
      timeoutMs: task.timeoutMs,
      attemptId,
    });
    const targets = socket ? [socket] : this.ctx.getWebSockets(task.assignedNodeId);
    for (const sock of targets) {
      try {
        sock.send(message);
      } catch {
        continue;
      }
      try { sock.serializeAttachment({ attemptId }); } catch {}
      await this.recordAttempt(task.id, task.assignedNodeId, task.tenantId, attemptId);
      return true;
    }
    return false;
  }

  private async tryAssignAll() {
    const pendingIds = await this.getPending();
    if (pendingIds.length === 0) return;

    const idleNodes = await this.getIdleNodes();
    if (idleNodes.length === 0) return;

    // Load the candidate nodes once instead of per (task, node) pair, and only
    // examine the head of the queue: the pass must stay bounded even when the
    // queue is at its cap.
    const nodes = new Map<string, NodeRecord>();
    for (const id of idleNodes) {
      const node = await this.ctx.storage.get<NodeRecord>(`node:${id}`);
      if (node) nodes.set(id, node);
    }
    let remainingIdle = idleNodes.filter(id => nodes.has(id));

    for (const taskId of pendingIds.slice(0, MAX_ASSIGN_PER_PASS)) {
      const task = await this.getTask(taskId);
      if (!task || task.status !== "pending") continue;

      if (task.workload === "swarm-inference") {
        const chosen = await this.tryAssignSwarm(task, nodes, remainingIdle);
        if (chosen) {
          remainingIdle = remainingIdle.filter(id => !chosen.includes(id));
          await this.ctx.storage.put("nodes:idle", remainingIdle);
        }
        continue;
      }

      let chosenNode: string | null = null;
      let bestAssigned = Infinity;
      let bestBucket = Infinity;
      let bestConnectedAt = Infinity;

      for (const nodeId of remainingIdle) {
        const node = nodes.get(nodeId);
        if (!node || node.status !== "idle") continue;
        if (!node.capabilities.includes(task.workload as WorkloadType)) continue;
        // Never hand a heavy WASM workload to a low-memory / mobile node; the
        // model load would spike memory and get the device's process killed.
        if (node.lowMemory && HEAVY_WORKLOADS.has(task.workload)) continue;
        // Site allow-list, matched against the token-bound site id.
        if (task.allowedSites?.length && !(node.siteId && task.allowedSites.includes(node.siteId))) continue;
        const sockets = this.ctx.getWebSockets(nodeId);
        if (sockets.length === 0) continue;

        // `cpuLoad` is self-reported and cannot be verified, so it is only a
        // tie-break inside an equal-use group: a node that lies about its load
        // cannot monopolize the queue because the node with fewer assignments
        // always wins first.
        const assigned = node.assignedCount ?? 0;
        const bucket = loadBucket(node.cpuLoad);
        if (
          assigned < bestAssigned ||
          (assigned === bestAssigned && bucket < bestBucket) ||
          (assigned === bestAssigned && bucket === bestBucket && node.connectedAt < bestConnectedAt)
        ) {
          chosenNode = nodeId;
          bestAssigned = assigned;
          bestBucket = bucket;
          bestConnectedAt = node.connectedAt;
        }
      }

      if (!chosenNode) continue;

      task.status = "processing";
      task.assignedNodeId = chosenNode;
      task.assignedAt = Date.now();
      await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);

      this.pendingCache = pendingIds.filter(id => id !== taskId);
      await this.ctx.storage.put("queue:pending", this.pendingCache);
      await this.removeFromTenantPending(task.tenantId, taskId);

      const processing = await this.getProcessing();
      this.processingCache = processing;
      if (!this.processingCache.includes(taskId)) {
        this.processingCache.push(taskId);
      }
      await this.ctx.storage.put("queue:processing", this.processingCache);

      const node = nodes.get(chosenNode);
      if (node) {
        node.status = "busy";
        node.currentTaskId = taskId;
        node.assignedCount = (node.assignedCount ?? 0) + 1;
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
  private async tryAssignSwarm(
    task: TaskRecord,
    nodes: Map<string, NodeRecord>,
    idle: string[],
  ): Promise<string[] | null> {
    const payload = task.payload as SwarmInferencePayload;
    const opts = payload?.swarm ?? {};
    // `payload` is unvalidated API input: `Math.floor("abc")` is NaN, and NaN
    // silently defeats both the availability check and `slice(0, ...)`. Anything
    // that is not a usable count falls back to the default instead of wedging
    // the scheduler (or the task) on a bad payload.
    const asCount = (value: unknown, fallback: number): number => {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || n < 1) return fallback;
      return Math.min(Math.floor(n), MAX_SWARM_NODES);
    };
    const minNodes = asCount(opts.minNodes, DEFAULT_MIN_SWARM_NODES);
    const maxNodes = Math.max(minNodes, asCount(opts.maxNodes, DEFAULT_MAX_SWARM_NODES));

    const eligible: NodeRecord[] = [];
    for (const nodeId of idle) {
      const node = nodes.get(nodeId);
      if (!node || node.status !== "idle") continue;
      if (!node.capabilities.includes("swarm-inference")) continue;
      if (!node.webgpu) continue;
      if (node.lowMemory) continue;
      if (task.allowedSites?.length && !(node.siteId && task.allowedSites.includes(node.siteId))) continue;
      if (this.ctx.getWebSockets(nodeId).length === 0) continue;
      eligible.push(node);
    }
    // A swarm needs several distinct candidates: a single node would hold the
    // whole model (and see the whole prompt) on its own.
    if (eligible.length < Math.max(minNodes, MIN_SWARM_CANDIDATES)) return null;

    // Warm first, then strongest devices: a node that already holds the model's
    // byte ranges skips the range download entirely, which dominates the load
    // time on crowd links. `preferWarm` defaults to true; the capacity ordering
    // still decides the host within each group (index 0 runs embedding, head,
    // sampling).
    const preferWarm = opts.preferWarm !== false;
    const wantedModel = typeof payload?.model === "string" ? payload.model : "";
    const isWarm = (n: NodeRecord) =>
      !!n.warmModels?.some((m) => m.modelId === wantedModel);
    const capacity = (n: NodeRecord) =>
      clampByteCapacity(n.wasmMemoryBytes) ?? clampByteCapacity(n.maxStorageBufferBindingSize) ?? 0;
    eligible.sort(
      (a, b) =>
        (preferWarm ? Number(isWarm(b)) - Number(isWarm(a)) : 0) ||
        capacity(b) - capacity(a) ||
        (a.assignedCount ?? 0) - (b.assignedCount ?? 0) ||
        a.connectedAt - b.connectedAt,
    );
    const chosen = eligible.slice(0, Math.min(maxNodes, eligible.length));
    if (chosen.length === 0) return null;
    const host = chosen[0];
    const sessionId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const members = chosen.map((n) => ({
      nodeId: n.id,
      capacity: capacity(n) || 1,
    }));

    task.status = "processing";
    task.assignedNodeId = host.id;
    task.assignedAt = Date.now();
    await this.ctx.storage.put(this.taskKey(task.tenantId, task.id), task);

    this.pendingCache = (await this.getPending()).filter(id => id !== task.id);
    await this.ctx.storage.put("queue:pending", this.pendingCache);
    await this.removeFromTenantPending(task.tenantId, task.id);
    const processing = await this.getProcessing();
    if (!processing.includes(task.id)) processing.push(task.id);
    this.processingCache = processing;
    await this.ctx.storage.put("queue:processing", processing);

    for (const n of chosen) {
      n.status = "busy";
      n.currentTaskId = task.id;
      n.assignedCount = (n.assignedCount ?? 0) + 1;
      await this.ctx.storage.put(`node:${n.id}`, n);
    }

    const record: SwarmRecord = {
      sessionId,
      taskId: task.id,
      hostNodeId: host.id,
      members,
      ready: [],
    };
    await this.ctx.storage.put(`swarm:${task.id}`, record);

    const init: SwarmInitMessage = {
      type: "swarm-init",
      sessionId,
      taskId: task.id,
      model: payload?.model ?? "",
      timeoutMs: task.timeoutMs,
      members,
      prompt: payload?.prompt ?? "",
      maxNewTokens: payload?.maxNewTokens,
    };
    if (!this.sendAttemptToNode(host.id, init, attemptId)) {
      await this.failTask(task.id, "Failed to deliver swarm session to host");
      return null;
    }
    await this.recordAttempt(task.id, host.id, task.tenantId, attemptId);

    return chosen.map(n => n.id);
  }

  async alarm() {
    const now = Date.now();
    const processingIds = await this.getProcessing();

    for (const taskId of processingIds) {
      const task = await this.getTask(taskId);
      if (!task) {
        // Unresolvable queue entry (e.g. a record from before tenant-scoped
        // keys): drop it instead of keeping the alarm loop alive forever.
        this.processingCache = processingIds.filter(id => id !== taskId);
        await this.ctx.storage.put("queue:processing", this.processingCache);
        continue;
      }
      if (task.assignedAt && now - task.assignedAt > (task.timeoutMs || DEFAULT_TIMEOUT_MS)) {
        await this.failTask(taskId, "Task timed out");
      }
    }

    // Sweep the pending queue: a task nobody can serve must fail instead of
    // living forever (and pinning storage) when no eligible node ever appears.
    const pendingIds = await this.getPending();
    for (const taskId of pendingIds) {
      const task = await this.getTask(taskId);
      if (!task || task.status !== "pending") {
        if (!task) {
          this.pendingCache = (await this.getPending()).filter(id => id !== taskId);
          await this.ctx.storage.put("queue:pending", this.pendingCache);
        }
        continue;
      }
      const ttl = Math.min(task.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_PENDING_TTL_MS);
      if (now - task.createdAt > ttl) {
        await this.failTask(
          taskId,
          task.allowedSites?.length
            ? "No eligible node for the requested sites"
            : "No eligible node picked up the task before its queue deadline",
          undefined,
          true,
          true,
        );
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

  private async checkRateLimitKey(key: string, max: number, windowMs = 60000): Promise<boolean> {
    const now = Date.now();
    const entry = await this.ctx.storage.get<RateEntry>(key);
    if (!entry || now > entry.resetAt) {
      await this.ctx.storage.put(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    await this.ctx.storage.put(key, entry);
    return true;
  }

  private async checkIpRateLimit(request: Request, kind: string): Promise<boolean> {
    const maxStr = this.env.RATE_LIMIT_MAX || '100';
    const max = parseInt(maxStr, 10) || 100;
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    return this.checkRateLimitKey(`rate:${kind}:${ip}`, max);
  }

  // --- Helpers ---

  private taskKey(tenantId: string, taskId: string): string {
    return `task:${tenantId}:${taskId}`;
  }

  /**
   * Resolve a task by its global id. The tenant comes from the internal index
   * unless the caller (the tenant-scoped REST route) supplies it, so node
   * messages never need to carry a tenant id and a cross-tenant read is
   * impossible: the key itself is namespaced.
   */
  private async getTask(taskId: string, tenantId?: string): Promise<TaskRecord | undefined> {
    const tenant = tenantId ?? await this.ctx.storage.get<string>(`taskindex:${taskId}`);
    if (!tenant) return undefined;
    const task = await this.ctx.storage.get<TaskRecord>(this.taskKey(tenant, taskId));
    if (!task || task.tenantId !== tenant) return undefined;
    return task;
  }

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

  private async getTenantPending(tenantId: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(`pending:${tenantId}`)) || [];
  }

  private async putTenantPending(tenantId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      await this.ctx.storage.delete(`pending:${tenantId}`);
      return;
    }
    await this.ctx.storage.put(`pending:${tenantId}`, ids);
  }

  private async removeFromTenantPending(tenantId: string, taskId: string): Promise<void> {
    const ids = await this.getTenantPending(tenantId);
    if (!ids.includes(taskId)) return;
    await this.putTenantPending(tenantId, ids.filter(id => id !== taskId));
  }
}

/** Quantize a self-reported load so ties fall through to the fairness counter. */
function loadBucket(load: number): number {
  if (!Number.isFinite(load)) return 1;
  return Math.round(Math.min(1, Math.max(0, load)) * 4) / 4;
}