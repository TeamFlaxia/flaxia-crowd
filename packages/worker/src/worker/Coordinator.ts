import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import type {
  TaskRecord,
  TaskQueueStats,
  NodeResourceReport,
  NodeModelCacheSnapshot,
  WarmModelRange,
  WorkloadType,
} from "@flaxia/sdk";
import {
  HEAVY_WORKLOADS,
  MAX_SUBSCRIBER_INFLIGHT_TOKENS,
  MAX_SUBSCRIBER_INFLIGHT_BYTES,
  SUBSCRIBER_ACK_TIMEOUT_MS,
  SUBSCRIBER_PAUSE_AT_TOKENS,
  SUBSCRIBER_RESUME_AT_TOKENS,
  validateNodeResourceReport,
  isNodeModelCacheSnapshot,
  THEIA_DLLM_MODEL_ID,
} from "@flaxia/sdk";
import { clampByteCapacity, createWebhookSignature, validateCallbackUrl } from "../security";
import { parseWarmModels } from "../crowd";
import {
  rankPlacementCandidates,
  reservationBlocksAllocation,
  reservationMatches,
  type NodeReservation,
  type PlacementCandidate,
} from "./scheduler";
import { orderPendingTasks, parseTenantSchedulingWeights, TASK_PRIORITY_DEFAULT, type PendingTaskSummary } from "./queue-scheduler";

export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_RETRIES = 3;
export const STALE_NODE_MS = 60000;
export const ALARM_INTERVAL_MS = 30000;

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
/** WebSocket bytes queued for an older SDK without per-token acknowledgements. */
const MAX_LEGACY_SUBSCRIBER_BUFFERED_BYTES = 256 * 1024;

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
  /**
   * Legacy/self-reported site id. This is not authenticated and must never
   * satisfy a task's allowedSites restriction.
   */
  siteId?: string;
  /** Measured WASM memory the device can commit; used for placement ordering. */
  wasmMemoryBytes?: number;
  /** Node understands and can fetch the additive container `fileSources` field. */
  fileSources?: boolean;
  /** Model layer spans already cached on the node. */
  warmModels?: WarmModelRange[];
  /** Short-lived self-reported measurements; used only as scheduling hints. */
  resources?: NodeResourceReport;
  /** Self-reported executable model state; a short-lived scheduling hint only. */
  modelCache?: NodeModelCacheSnapshot;
  /** Tasks handed to this node so far, used as a fairness tie-break. */
  assignedCount?: number;
  /** Lease for the task currently holding this node; fenced by attempt generation. */
  reservation?: NodeReservation;
}

/** True for container tasks whose bytes are fetched from a scoped reference. */
function taskNeedsFileSources(task: TaskRecord): boolean {
  const payload = task.payload;
  return Boolean(
    task.workload === 'container' &&
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'fileSources' in payload,
  );
}

/**
 * Model a workload loads even though its payload has no reusable `model` field.
 *
 * Placement otherwise only sees a warm match for `ai-inference`, so a
 * node that already holds the embedding encoder or the detector never wins its
 * own follow-up tasks. These ids mirror `model-manifest.json`.
 */
export function implicitWarmModelId(workload: string): string {
  switch (workload) {
    case 'embed-gemma':
    case 'vector-embed':
      return 'google/embeddinggemma-2';
    case 'nudenet':
      return 'deepghs/nudenet_onnx';
    case 'theia-inference':
      return THEIA_DLLM_MODEL_ID;
    default:
      return '';
  }
}

/**
 * The cache identity a task will actually warm.
 *
 * `embed-gemma`/`vector-embed`/`nudenet` accept a public alias in
 * `payload.model` (`'320n'`, `'onnx-community/embeddinggemma-2-ONNX'`), never
 * the manifest id the node reports in its heartbeat. Prefer the workload
 * identity for those, otherwise warm placement silently never matches.
 */
export function resolveWarmModelId(workload: string, payloadModel: unknown): string {
  const implicit = implicitWarmModelId(workload);
  if (implicit) return implicit;
  return typeof payloadModel === 'string' && payloadModel ? payloadModel : '';
}

/**
 * The delivery attempt currently allowed to settle a task. `attemptId` is
 * regenerated on every delivery and retired when the attempt ends, so a late
 * message from a previous attempt (or a forged one) changes nothing.
 */
interface AttemptRecord {
  attemptId: string;
  generation: string;
  nodeId: string;
  tenantId: string;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

interface SubscriberAttachment {
  sentSequence: number;
  ackSequence: number;
  unackedTokenBytes: number[];
  inflightBytes: number;
  flowControl: boolean;
  lastAckAt: number;
}

interface TenantQueueCounters {
  assignedByPriority: Record<0 | 1 | 2 | 3, number>;
  rejectionCounts: Record<"global-cap" | "tenant-cap" | "enqueue-rate", number>;
  lastAssignmentWaitMs: number | null;
  maxAssignmentWaitMs: number | null;
  updatedAt: number | null;
}

function emptyTenantQueueCounters(): TenantQueueCounters {
  return {
    assignedByPriority: { 0: 0, 1: 0, 2: 0, 3: 0 },
    rejectionCounts: { "global-cap": 0, "tenant-cap": 0, "enqueue-rate": 0 },
    lastAssignmentWaitMs: null,
    maxAssignmentWaitMs: null,
    updatedAt: null,
  };
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

    // Storage-backed rate limit for the unauthenticated `/nodes/register`
    // route, which lives in the Worker but shares the coordinator's limiter.
    if (url.pathname === "/register-rate") {
      if (!(await this.checkIpRateLimit(request, "register"))) {
        return new Response("Rate limit exceeded", { status: 429 });
      }
      return new Response("OK");
    }

    if (url.pathname === "/enqueue") {
      return this.handleEnqueue(request);
    }

    if (url.pathname === "/queue-stats") {
      return this.handleQueueStats(url);
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
    // `site` is only a client-submitted claim that was signed by the Worker.
    // Registration is public, so that signature does not prove control of the
    // claimed site. Keep it for diagnostics/legacy API shape only; restricted
    // tasks require a verified origin proof (not implemented), so no node is
    // eligible for allowedSites today.
    const siteId = url.searchParams.get("site") || undefined;
    const wasmRaw = url.searchParams.get("wasm");
    const wasmMemoryBytes = clampByteCapacity(wasmRaw === null ? undefined : Number(wasmRaw));
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
    if (existing?.currentTaskId) {
      const inFlight = await this.getTask(existing.currentTaskId);
      if (inFlight && inFlight.status === "processing" && inFlight.assignedNodeId === nodeId) {
        resumeTask = inFlight;
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
      // An unmeasured node must not receive the best possible load score.
      cpuLoad: existing?.cpuLoad ?? 1,
      connectedAt: existing?.connectedAt ?? Date.now(),
      lastPongAt: Date.now(),
      currentTaskId: resumeTask?.id,
      reservation: resumeTask
        ? existing?.reservation ?? {
            taskId: resumeTask.id,
            generation: crypto.randomUUID(),
            expiresAt: (resumeTask.assignedAt ?? Date.now()) + (resumeTask.timeoutMs || DEFAULT_TIMEOUT_MS),
          }
        : undefined,
      lowMemory: url.searchParams.get("lowMemory") === "true",
      siteId,
      fileSources: url.searchParams.get("fileSources") === "true",
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
    if (resumeTask) {
      if (!(await this.deliverTask(resumeTask, server))) {
        await this.failTask(resumeTask.id, "Failed to deliver task to node");
      }
    }

    await this.tryAssignAll();

    // A signaling-only node can be the first activity in a fresh coordinator.
    // Start heartbeats without waiting for a task to schedule the first alarm,
    // and keep any earlier task deadline already pending.
    const heartbeatAt = Date.now() + ALARM_INTERVAL_MS;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > heartbeatAt) {
      await this.ctx.storage.setAlarm(heartbeatAt);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const tags = this.ctx.getTags(ws);
    const connectionId = tags[0];

    if (!connectionId) return;
    const subscriber = connectionId.startsWith("client:");

    // Node-to-coordinator messages are JSON. A binary frame has no protocol
    // meaning and is dropped without touching task state.
    if (message instanceof ArrayBuffer) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(message as string);
    } catch {
      return;
    }

    try {
      if (subscriber) {
        await this.handleSubscriberControl(ws, connectionId.slice("client:".length), data);
        return;
      }

      const nodeId = connectionId;
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
          const resources = validateNodeResourceReport(data.resources);
          if (resources) {
            node.resources = resources;
          }
          if (data.modelCache === null) {
            delete node.modelCache;
          } else if (isNodeModelCacheSnapshot(data.modelCache)) {
            node.modelCache = data.modelCache;
          }
          await this.ctx.storage.put(`node:${nodeId}`, node);
        }
        return;
      }

      if (data.type === "result" || data.type === "error") {
        await this.handleSettlement(ws, nodeId, data);
        return;
      }

      if (data.type === "progress") {
        await this.handleProgress(ws, nodeId, data);
        return;
      }
    } catch {}
  }

  // --- Node messaging ---

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
    await this.ctx.storage.put(`attempt:${taskId}`, {
      attemptId,
      generation: attemptId,
      nodeId,
      tenantId,
    } satisfies AttemptRecord);
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
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    const generation = attempt.generation ?? attempt.attemptId;
    if (node?.reservation && (!reservationMatches(node.reservation, taskId, generation) ||
        node.reservation.expiresAt <= Date.now())) return null;
    let attachment: { attemptId?: string } | undefined;
    try {
      attachment = ws.deserializeAttachment() as { attemptId?: string } | undefined;
    } catch {
      attachment = undefined;
    }
    if (attachment?.attemptId !== attempt.attemptId) return null;
    return attempt.attemptId;
  }

  /**
   * Settle a task from a node message (`result` / `error`).
   *
   * Only the node holding the current delivery attempt may settle the task;
   * both the attempt id and the receiving socket are checked.
   */
  private async handleSettlement(ws: WebSocket, nodeId: string, data: Record<string, unknown>) {
    const taskId = typeof data.taskId === "string" ? data.taskId : "";
    if (!taskId) return;
    const isError = data.type !== "result";
    const error = typeof data.error === "string" ? data.error : "Node error";

    const attemptId = await this.acceptAttempt(ws, taskId, nodeId, data.attemptId);
    if (!attemptId) return;

    if (isError) {
      await this.failTask(taskId, error, nodeId);
    } else {
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

    if (!(await this.acceptAttempt(ws, taskId, nodeId, data.attemptId))) return;
    if (!(await this.checkRateLimitKey(`rate:progress:${taskId}`, MAX_PROGRESS_PER_SECOND, 1000))) return;

    const subs = this.ctx.getWebSockets(`client:${taskId}`);
    const excluded = new Set<WebSocket>();
    for (const sub of subs) {
      const attachment = this.readSubscriberAttachment(sub);
      const inflight = attachment.sentSequence - attachment.ackSequence;
      const bufferedAmount = (sub as WebSocket & { bufferedAmount?: number }).bufferedAmount;
      const sequence = attachment.sentSequence + 1;
      const message = JSON.stringify({ type: "token", token, sequence });
      const messageBytes = new TextEncoder().encode(message).byteLength;
      if (
        inflight >= MAX_SUBSCRIBER_INFLIGHT_TOKENS ||
        attachment.inflightBytes + messageBytes > MAX_SUBSCRIBER_INFLIGHT_BYTES ||
        (typeof bufferedAmount === "number" && bufferedAmount > MAX_SUBSCRIBER_INFLIGHT_BYTES) ||
        (!attachment.flowControl && typeof bufferedAmount === "number" && bufferedAmount > MAX_LEGACY_SUBSCRIBER_BUFFERED_BYTES)
      ) {
        this.closeSlowSubscriber(sub);
        excluded.add(sub);
        continue;
      }
      try {
        sub.send(message);
        if (inflight === 0) attachment.lastAckAt = Date.now();
        attachment.sentSequence = sequence;
        attachment.unackedTokenBytes.push(messageBytes);
        attachment.inflightBytes += messageBytes;
        this.writeSubscriberAttachment(sub, attachment);
        // Legacy SDKs do not acknowledge callback completion. Send at most one
        // fixed window, then disconnect them to keep their browser-side queue finite.
        if (!attachment.flowControl && sequence - attachment.ackSequence >= MAX_SUBSCRIBER_INFLIGHT_TOKENS) {
          this.closeSlowSubscriber(sub);
          excluded.add(sub);
        }
      } catch {
        excluded.add(sub);
      }
    }
    await this.updateSubscriberFlow(taskId, excluded);
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
      await this.updateSubscriberFlow(tag.slice("client:".length), new Set([ws]));
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

  private readSubscriberAttachment(ws: WebSocket): SubscriberAttachment {
    try {
      const value = ws.deserializeAttachment() as Partial<SubscriberAttachment> | undefined;
      const sentSequence = Number.isSafeInteger(value?.sentSequence) && value!.sentSequence! >= 0
        ? value!.sentSequence!
        : 0;
      const rawAckSequence = Number.isSafeInteger(value?.ackSequence) && value!.ackSequence! >= 0
        ? value!.ackSequence!
        : 0;
      const ackSequence = Math.min(sentSequence, rawAckSequence);
      const rawBytes = Array.isArray(value?.unackedTokenBytes)
        ? value.unackedTokenBytes.filter((bytes) => Number.isSafeInteger(bytes) && bytes >= 0).slice(0, MAX_SUBSCRIBER_INFLIGHT_TOKENS)
        : [];
      if (rawBytes.length !== sentSequence - ackSequence) {
        return { sentSequence: 0, ackSequence: 0, unackedTokenBytes: [], inflightBytes: 0, flowControl: false, lastAckAt: Date.now() };
      }
      return {
        sentSequence,
        ackSequence,
        unackedTokenBytes: rawBytes,
        inflightBytes: rawBytes.reduce((sum, bytes) => sum + bytes, 0),
        flowControl: value?.flowControl === true,
        lastAckAt: typeof value?.lastAckAt === "number" && Number.isFinite(value.lastAckAt) ? value.lastAckAt : Date.now(),
      };
    } catch {
      return { sentSequence: 0, ackSequence: 0, unackedTokenBytes: [], inflightBytes: 0, flowControl: false, lastAckAt: Date.now() };
    }
  }

  private writeSubscriberAttachment(ws: WebSocket, attachment: SubscriberAttachment) {
    try { ws.serializeAttachment(attachment); } catch {}
  }

  private async handleSubscriberControl(ws: WebSocket, taskId: string, data: Record<string, unknown>) {
    const attachment = this.readSubscriberAttachment(ws);
    if (data.type === "flow-control" && data.version === 1) {
      attachment.flowControl = true;
      this.writeSubscriberAttachment(ws, attachment);
      await this.updateSubscriberFlow(taskId);
      return;
    }
    if (data.type !== "ack" || !attachment.flowControl) return;
    const sequence = data.sequence;
    if (!Number.isSafeInteger(sequence) || typeof sequence !== "number") return;
    if (sequence <= attachment.ackSequence || sequence > attachment.sentSequence) return;
    const acknowledged = sequence - attachment.ackSequence;
    if (acknowledged > attachment.unackedTokenBytes.length) return;
    attachment.unackedTokenBytes.splice(0, acknowledged);
    attachment.inflightBytes = attachment.unackedTokenBytes.reduce((sum, bytes) => sum + bytes, 0);
    attachment.ackSequence = sequence;
    attachment.lastAckAt = Date.now();
    this.writeSubscriberAttachment(ws, attachment);
    await this.updateSubscriberFlow(taskId);
  }

  private closeSlowSubscriber(ws: WebSocket) {
    try { ws.send(JSON.stringify({ type: "error", error: "Subscription closed because the token consumer is too slow" })); } catch {}
    try { ws.close(1013, "slow token consumer"); } catch {}
  }

  /** Pause the producer at a token boundary while any current subscriber is above its high watermark. */
  private async updateSubscriberFlow(taskId: string, excluded: Set<WebSocket> = new Set()) {
    const task = await this.getTask(taskId);
    if (!task || task.status !== "processing" || !task.assignedNodeId) return;

    const attempt = await this.ctx.storage.get<AttemptRecord>(`attempt:${taskId}`);
    const flowKey = `flow:${taskId}`;
    const previous = await this.ctx.storage.get<{ attemptId: string; paused: boolean }>(flowKey);
    const wasPaused = previous?.attemptId === attempt?.attemptId && previous?.paused === true;
    const now = Date.now();
    let paused = false;
    const subscribers = this.ctx.getWebSockets(`client:${taskId}`);
    for (const sub of subscribers) {
      if (excluded.has(sub)) continue;
      const attachment = this.readSubscriberAttachment(sub);
      const inflight = attachment.sentSequence - attachment.ackSequence;
      if (inflight > 0 && now - attachment.lastAckAt >= SUBSCRIBER_ACK_TIMEOUT_MS) {
        this.closeSlowSubscriber(sub);
        continue;
      }
      const bufferedAmount = (sub as WebSocket & { bufferedAmount?: number }).bufferedAmount;
      if (
        inflight >= MAX_SUBSCRIBER_INFLIGHT_TOKENS ||
        attachment.inflightBytes > MAX_SUBSCRIBER_INFLIGHT_BYTES ||
        (typeof bufferedAmount === "number" && bufferedAmount > MAX_SUBSCRIBER_INFLIGHT_BYTES) ||
        (!attachment.flowControl && typeof bufferedAmount === "number" && bufferedAmount > MAX_LEGACY_SUBSCRIBER_BUFFERED_BYTES)
      ) {
        this.closeSlowSubscriber(sub);
        continue;
      }
      if (attachment.flowControl && (inflight >= SUBSCRIBER_PAUSE_AT_TOKENS ||
          (wasPaused && inflight > SUBSCRIBER_RESUME_AT_TOKENS))) paused = true;
    }

    if (!attempt) return;
    if (previous?.attemptId === attempt.attemptId && previous.paused === paused) return;
    if (previous?.attemptId !== attempt.attemptId && !paused) {
      await this.ctx.storage.delete(flowKey);
      return;
    }
    await this.ctx.storage.put(flowKey, { attemptId: attempt.attemptId, paused });
    this.sendAttemptToNode(attempt.nodeId, { type: "task-flow", taskId, paused }, attempt.attemptId);
  }

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
    this.writeSubscriberAttachment(server, {
      sentSequence: 0,
      ackSequence: 0,
      unackedTokenBytes: [],
      inflightBytes: 0,
      flowControl: false,
      lastAckAt: Date.now(),
    });
    server.send(JSON.stringify({ type: "subscribed", taskId, flowControl: "ack-v1" }));
    await this.updateSubscriberFlow(taskId);
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
    if (typeof body.createdAt !== "number" || !Number.isFinite(body.createdAt)) {
      return Response.json({ error: "Task createdAt must be a finite timestamp" }, { status: 400 });
    }
    if (body.priority !== undefined &&
        !(typeof body.priority === "number" && Number.isInteger(body.priority) && body.priority >= 0 && body.priority <= 3)) {
      return Response.json({ error: "Task priority must be an integer between 0 and 3" }, { status: 400 });
    }
    body.priority ??= TASK_PRIORITY_DEFAULT;
    // Fail closed rather than deliver an unsigned (forgeable) webhook.
    if (body.callbackUrl && !this.env.WEBHOOK_SIGNING_SECRET) {
      return Response.json({ error: "Webhook signing is not configured" }, { status: 400 });
    }

    const pending = await this.getPending();
    if (pending.length >= MAX_PENDING_TASKS) {
      await this.recordQueueRejection(body.tenantId, "global-cap");
      return Response.json({ error: "Task queue is full" }, { status: 429 });
    }
    const tenantPending = await this.getTenantPending(body.tenantId);
    if (tenantPending.length >= MAX_PENDING_TASKS_PER_TENANT) {
      await this.recordQueueRejection(body.tenantId, "tenant-cap");
      return Response.json({ error: "Tenant pending-task limit reached" }, { status: 429 });
    }
    if (!(await this.checkRateLimitKey(`rate:enqueue:${body.tenantId}`, MAX_ENQUEUE_PER_MINUTE))) {
      await this.recordQueueRejection(body.tenantId, "enqueue-rate");
      return Response.json({ error: "Enqueue rate limit exceeded" }, { status: 429 });
    }

    if (typeof body.queuedAt !== "number" || !Number.isFinite(body.queuedAt)) body.queuedAt = body.createdAt;

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

  private async handleQueueStats(url: URL): Promise<Response> {
    const tenantId = url.searchParams.get("tenantId");
    if (!tenantId || tenantId.length > 128) return Response.json({ error: "Invalid tenant" }, { status: 400 });
    const counters = await this.ctx.storage.get<TenantQueueCounters>(`queue:stats:${tenantId}`) ?? emptyTenantQueueCounters();
    const pendingByPriority: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const pendingIds = (await this.getTenantPending(tenantId)).slice(0, MAX_PENDING_TASKS_PER_TENANT);
    let oldestPendingWaitMs: number | null = null;
    const now = Date.now();
    for (const taskId of pendingIds) {
      const task = await this.getTask(taskId, tenantId);
      if (!task || task.status !== "pending") continue;
      const priority = task.priority === 0 || task.priority === 2 || task.priority === 3 ? task.priority : 1;
      pendingByPriority[priority]++;
      const queueStartedAt = Number.isFinite(task.queuedAt) ? task.queuedAt! : task.createdAt;
      const waitMs = Math.max(0, now - queueStartedAt);
      oldestPendingWaitMs = oldestPendingWaitMs === null ? waitMs : Math.max(oldestPendingWaitMs, waitMs);
    }
    const stats: TaskQueueStats = {
      pendingCount: Object.values(pendingByPriority).reduce((sum, value) => sum + value, 0),
      pendingByPriority,
      assignedByPriority: counters.assignedByPriority,
      rejectionCounts: counters.rejectionCounts,
      oldestPendingWaitMs,
      lastAssignmentWaitMs: counters.lastAssignmentWaitMs,
      maxAssignmentWaitMs: counters.maxAssignmentWaitMs,
      updatedAt: counters.updatedAt,
    };
    return Response.json(stats);
  }

  private async readTenantQueueCounters(tenantId: string): Promise<TenantQueueCounters> {
    return await this.ctx.storage.get<TenantQueueCounters>(`queue:stats:${tenantId}`) ?? emptyTenantQueueCounters();
  }

  private async recordQueueRejection(
    tenantId: string,
    reason: "global-cap" | "tenant-cap" | "enqueue-rate",
  ) {
    const stats = await this.readTenantQueueCounters(tenantId);
    stats.rejectionCounts[reason] = Math.min(Number.MAX_SAFE_INTEGER, stats.rejectionCounts[reason] + 1);
    stats.updatedAt = Date.now();
    await this.ctx.storage.put(`queue:stats:${tenantId}`, stats);
  }

  private async recordQueueAssignment(task: TaskRecord) {
    const stats = await this.readTenantQueueCounters(task.tenantId);
    const priority = task.priority === 0 || task.priority === 2 || task.priority === 3 ? task.priority : 1;
    stats.assignedByPriority[priority] = Math.min(Number.MAX_SAFE_INTEGER, stats.assignedByPriority[priority] + 1);
    stats.lastAssignmentWaitMs = task.queueWaitMs ?? 0;
    stats.maxAssignmentWaitMs = Math.max(stats.maxAssignmentWaitMs ?? 0, task.queueWaitMs ?? 0);
    stats.updatedAt = Date.now();
    await this.ctx.storage.put(`queue:stats:${task.tenantId}`, stats);
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
    await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);
    await this.retireAttempt(taskId);
    await this.ctx.storage.delete(`flow:${taskId}`);
    await this.removeFromTenantPending(task.tenantId, taskId);
    await this.releaseNode(nodeId, taskId, attemptId);

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

    // The delivery attempt ends here either way, so a late message from it must
    // not be able to settle the task after this point.
    const reservedNode = task.assignedNodeId
      ? await this.ctx.storage.get<NodeRecord>(`node:${task.assignedNodeId}`)
      : undefined;
    const reservationGeneration = reservedNode?.reservation?.taskId === taskId
      ? reservedNode.reservation.generation
      : undefined;
    await this.retireAttempt(taskId);
    await this.ctx.storage.delete(`flow:${taskId}`);

    const running = task.assignedNodeId ? [task.assignedNodeId] : [];
    for (const nodeId of running) {
      this.sendToNode(nodeId, { type: "abort", taskId, error });
    }
    if (task.assignedNodeId && release) {
      await this.releaseNode(task.assignedNodeId, taskId, reservationGeneration);
    }

    // Retry transient failures (timeout / disconnect) up to MAX_RETRIES times.
    // Keyed on retryCount (not status) so a task that was already requeued by
    // an earlier failure keeps its remaining retries instead of being
    // permanently failed by a second overlapping failure signal.
    if (!permanent && task.retryCount < MAX_RETRIES) {
      if (task.status === "processing") task.retryCount++;
      task.streamEpoch = (task.streamEpoch ?? 0) + 1;
      const reset = JSON.stringify({ type: "reset", epoch: task.streamEpoch });
      for (const sub of this.ctx.getWebSockets(`client:${taskId}`)) {
        try { sub.send(reset); } catch {}
      }
      task.status = "pending";
      task.assignedNodeId = undefined;
      task.assignedAt = undefined;
      task.queuedAt = Date.now();
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

  private async releaseNode(nodeId: string, taskId?: string, generation?: string) {
    const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
    if (!node) return;
    if (taskId && node.currentTaskId && node.currentTaskId !== taskId) return;
    if (taskId && node.reservation && !reservationMatches(node.reservation, taskId, generation)) return;
    node.status = "idle";
    node.currentTaskId = undefined;
    node.reservation = undefined;
    await this.ctx.storage.put(`node:${nodeId}`, node);

    const idleNodes = await this.getIdleNodes();
    if (!idleNodes.includes(nodeId)) {
      idleNodes.push(nodeId);
      await this.ctx.storage.put("nodes:idle", idleNodes);
    }
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
  private async deliverTask(task: TaskRecord, socket?: WebSocket, generation = crypto.randomUUID()): Promise<boolean> {
    if (!task.assignedNodeId) return false;
    const attemptId = generation;
    const node = await this.ctx.storage.get<NodeRecord>(`node:${task.assignedNodeId}`);
    if (node?.currentTaskId === task.id) {
      node.reservation = {
        taskId: task.id,
        generation,
        expiresAt: (task.assignedAt ?? Date.now()) + (task.timeoutMs || DEFAULT_TIMEOUT_MS),
      };
      await this.ctx.storage.put(`node:${task.assignedNodeId}`, node);
    }
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

    // Load candidate nodes once. The queue has a hard 500-task cap, and the
    // scheduler limits actual assignment attempts to MAX_ASSIGN_PER_PASS.
    const nodes = new Map<string, NodeRecord>();
    for (const id of idleNodes) {
      const node = await this.ctx.storage.get<NodeRecord>(`node:${id}`);
      if (node) nodes.set(id, node);
    }
    let remainingIdle = idleNodes.filter(id => nodes.has(id));
    // Load only the fields needed to order the queue. Materializing every full
    // task record (payloads up to MAX_PAYLOAD_SIZE) on each scheduling pass
    // could exhaust the DO's memory when the queue is full; full records are
    // loaded one at a time only for the tasks that are actually assigned.
    const summaries: PendingTaskSummary[] = [];
    for (const id of pendingIds) {
      const task = await this.getTask(id);
      if (task?.status === "pending") {
        summaries.push({
          id: task.id,
          tenantId: task.tenantId,
          createdAt: task.queuedAt ?? task.createdAt,
          priority: task.priority,
        });
      }
    }
    const queueOrder = orderPendingTasks(
      summaries,
      Date.now(),
      parseTenantSchedulingWeights(this.env.TENANT_SCHEDULING_WEIGHTS),
      await this.ctx.storage.get<string>("queue:tenantCursor") ?? null,
      await this.ctx.storage.get<number>("queue:tenantServed") ?? 0,
    );
    const orderedIds = queueOrder.ordered.map((task) => task.id);
    let assignments = 0;
    let servedCursor: { tenantId: string; served: number } | undefined;
    let remainingPending = pendingIds.slice();

    for (const taskId of orderedIds) {
      if (assignments >= MAX_ASSIGN_PER_PASS || !remainingIdle.length) break;
      const task = await this.getTask(taskId);
      if (!task || task.status !== "pending") continue;

      const candidates: PlacementCandidate[] = [];

      for (const nodeId of remainingIdle) {
        const node = nodes.get(nodeId);
        if (!node || node.status !== "idle") continue;
        if (reservationBlocksAllocation(node.reservation, Date.now())) continue;
        if (taskNeedsFileSources(task) && !node.fileSources) continue;
        if (!node.capabilities.includes(task.workload as WorkloadType)) continue;
        // Never hand a heavy WASM workload to a low-memory / mobile node; the
        // model load would spike memory and get the device's process killed.
        if (node.lowMemory && HEAVY_WORKLOADS.has(task.workload)) continue;
        // There is no verified node-site proof yet. Do not treat a signed but
        // self-asserted `siteId` as authentication for a site's allow-list.
        if (task.allowedSites?.length) continue;
        const sockets = this.ctx.getWebSockets(nodeId);
        if (sockets.length === 0) continue;

        const now = Date.now();
        const report = node.resources;
        const gpuMetric = report?.gpu.computeCompletionMs;
        const gpuCompletionMs = report && report.expiresAt > now && report.gpu.expiresAt > now &&
          gpuMetric?.source === "measured" && gpuMetric.expiresAt > now && gpuMetric.value !== null
          ? gpuMetric.value
          : null;
        const cpuMetric = report?.cpuLoad;
        const cpuLoad = report && report.expiresAt > now && cpuMetric?.source === "measured" &&
          cpuMetric.expiresAt > now && cpuMetric.value !== null
          ? cpuMetric.value
          : now - node.lastPongAt <= STALE_NODE_MS ? loadBucket(node.cpuLoad) : null;
        const payload = task.payload as { model?: unknown; options?: { dtype?: unknown; device?: unknown } } | null;
        const model = resolveWarmModelId(task.workload, payload?.model);
        const wantDtype = typeof payload?.options?.dtype === "string" ? payload.options.dtype : undefined;
        const wantBackend = typeof payload?.options?.device === "string" ? payload.options.device : undefined;
        candidates.push({
          nodeId,
          warmModel: !!model && (
            !!node.warmModels?.some((entry) => entry.modelId === model) ||
            !!(node.modelCache && node.modelCache.expiresAt > now && node.modelCache.entries.some((entry) => {
              if (entry.modelId !== model || entry.state !== "ready") return false;
              // A different quantization/backend is a different download: only
              // count it as warm when the task's dtype/device matches (or the
              // task does not pin one, matching the node's q4f16/wasm default).
              if (wantDtype !== undefined && entry.dtype !== wantDtype) return false;
              if (wantBackend !== undefined && entry.backend !== wantBackend) return false;
              return true;
            }))
          ),
          gpuCompletionMs,
          capacityBytes: clampByteCapacity(node.wasmMemoryBytes) ?? null,
          cpuLoad,
          assignedCount: node.assignedCount ?? 0,
          connectedAt: node.connectedAt,
        });
      }

      const selected = rankPlacementCandidates(candidates)[0];
      const chosenNode = selected?.candidate.nodeId ?? null;

      if (!chosenNode) continue;
      assignments++;
      servedCursor = queueOrder.cursorAfter[taskId];
      task.placementReason = selected.reason;

      task.status = "processing";
      task.assignedNodeId = chosenNode;
      task.assignedAt = Date.now();
      const queueStartedAt = Number.isFinite(task.queuedAt) ? task.queuedAt! : task.createdAt;
      task.queueWaitMs = Math.max(0, task.assignedAt - queueStartedAt);
      await this.recordQueueAssignment(task);
      await this.ctx.storage.put(this.taskKey(task.tenantId, taskId), task);

      remainingPending = remainingPending.filter(id => id !== taskId);
      this.pendingCache = remainingPending;
      await this.ctx.storage.put("queue:pending", this.pendingCache);
      await this.removeFromTenantPending(task.tenantId, taskId);

      const processing = await this.getProcessing();
      this.processingCache = processing;
      if (!this.processingCache.includes(taskId)) {
        this.processingCache.push(taskId);
      }
      await this.ctx.storage.put("queue:processing", this.processingCache);

      const node = nodes.get(chosenNode);
      const generation = crypto.randomUUID();
      if (node) {
        node.status = "busy";
        node.currentTaskId = taskId;
        node.assignedCount = (node.assignedCount ?? 0) + 1;
        node.reservation = {
          taskId,
          generation,
          expiresAt: task.assignedAt + (task.timeoutMs || DEFAULT_TIMEOUT_MS),
        };
        await this.ctx.storage.put(`node:${chosenNode}`, node);
      }

      remainingIdle = remainingIdle.filter(id => id !== chosenNode);
      await this.ctx.storage.put("nodes:idle", remainingIdle);

      const sent = await this.deliverTask(task, undefined, generation);

      // If the send failed, immediately fail the task (with retry) instead of
      // leaving it stuck in `processing`.
      if (!sent) {
        await this.failTask(taskId, "Failed to deliver task to node");
      }
    }

    if (servedCursor) {
      await this.ctx.storage.put("queue:tenantCursor", servedCursor.tenantId);
      await this.ctx.storage.put("queue:tenantServed", servedCursor.served);
    }
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
      const current = await this.getTask(taskId);
      if (current?.status === "processing") await this.updateSubscriberFlow(taskId);
    }

    // Sweep the pending queue: a task nobody can serve must fail instead of
    // living forever (and pinning storage) when no eligible node ever appears.
    this.pendingCache = null;
    const pendingIds = await this.ctx.storage.get<string[]>("queue:pending") || [];
    this.pendingCache = pendingIds;
    for (const taskId of pendingIds) {
      const task = await this.getTask(taskId);
      if (!task || task.status !== "pending") {
        this.pendingCache = this.pendingCache.filter(id => id !== taskId);
        await this.ctx.storage.put("queue:pending", this.pendingCache);
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
      let node = record as unknown as NodeRecord;

      if (node.reservation && now >= node.reservation.expiresAt) {
        const lease = node.reservation;
        const task = await this.getTask(lease.taskId);
        if (task?.status === "processing") {
          await this.failTask(task.id, "Node reservation expired");
        } else {
          await this.releaseNode(nodeId, lease.taskId, lease.generation);
        }
        node = (await this.ctx.storage.get<NodeRecord>(key)) ?? node;
      }

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
    const idleIds = new Set([...idleNodes, ...(await this.getIdleNodes())]);
    const reconciledIdle: string[] = [];
    for (const nodeId of idleIds) {
      const node = await this.ctx.storage.get<NodeRecord>(`node:${nodeId}`);
      if (node?.status === "idle" && now - node.lastPongAt <= STALE_NODE_MS) reconciledIdle.push(nodeId);
    }
    await this.ctx.storage.put("nodes:idle", reconciledIdle);

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
    if (pending.length > 0 && remainingIdle.length > 0) await this.tryAssignAll();
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
