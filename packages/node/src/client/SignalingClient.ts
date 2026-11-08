import { ConsentUI } from '../consent/ConsentUI';
import {
  clearConsent as clearPersistedConsent,
  getConsentState,
  hasConsent,
  saveConsent,
  saveDenial,
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
  safeRandomUUID,
} from '../consent/storage';
import { WorkerPool } from '../executor/WorkerPool';
import { HEAVY_WORKLOAD_WASM_MEMORY_BYTES, probeMaxWasmMemoryBytes } from '../executor/memoryProbe';
import { collectNodeResourceReport } from '../executor/resourceReporter';
import { assertPublicUrl } from '../executor/egress-guard';
import { isCurrentSwarmPeerSignal, SwarmPeerTransport } from '../swarm/peer-transport';
import { evaluateMobileLifecycle } from './mobile-lifecycle';
import { LightPreloader } from './light-preloader';
import {
  LIGHT_INFERENCE_PLAMO_TRANSLATE_DTYPE,
  LIGHT_INFERENCE_PLAMO_TRANSLATE_MODEL,
  LIGHT_INFERENCE_PLAMO_TRANSLATE_TASK,
  LIGHT_INFERENCE_TRANSLATE_DTYPE,
  LIGHT_INFERENCE_TRANSLATE_MODEL,
  LIGHT_INFERENCE_TRANSLATE_TASK,
} from './light-preloader';
import {
  HEAVY_WORKLOADS,
  buildNodeSignalProtocols,
  buildWsUrl,
  decodeSwarmEnvelope,
  encodeSwarmEnvelope,
  signSwarmEnvelope,
  verifySwarmEnvelope,
} from '@flaxia/sdk';

import type { ConsentState, FlaxiaNodeController, NodeConfig, SwarmNodeCapabilities, WorkloadType } from '@flaxia/sdk';
import type { AiInferencePayload, AiInferenceResult } from '@flaxia/sdk';
import { OndeviceUnavailableError } from '@flaxia/sdk';

const log = (...args: unknown[]) => console.log('[flaxia-node]', ...args);
const logError = (...args: unknown[]) => console.error('[flaxia-node]', ...args);

function validatedHttpsOrigins(origins?: readonly string[]): string[] {
  const valid = new Set<string>();
  if (!Array.isArray(origins)) return [];
  for (const value of origins.slice(0, 32)) {
    try {
      const parsed = assertPublicUrl(value);
      if (parsed.origin === value) valid.add(parsed.origin);
    } catch {
      // Invalid host configuration cannot advertise or fetch file sources.
    }
  }
  return [...valid];
}

export interface TaskMessage {
  type: 'task';
  taskId: string;
  workload: WorkloadType;
  payload: unknown;
  timeoutMs?: number;
  /**
   * Coordinator-generated id for this delivery. Must be echoed on `result`,
   * `progress` and `error`: the coordinator only accepts messages that arrive
   * on the socket that received the delivery and carry its attempt id.
   */
  attemptId?: string;
}

interface NodeToken {
  token: string;
  nodeId: string;
  expiresAt: number;
}

const NODE_ID_KEY = 'flaxia_node_id';
/**
 * Legacy key from when the raw node token was cached in localStorage. The token
 * now lives in memory only (an XSS on the host page must not be able to steal a
 * long-lived bearer), but old values are still purged on startup.
 */
const NODE_TOKEN_KEY = 'flaxia_node_token';

class SignalingClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30000;
  private destroyed = false;
  private suspended = false;
  private lifecycleCleanup: Array<() => void> = [];
  private lifecyclePageHidden = false;
  private lifecycleOffline = false;
  private lifecycleEpoch = 0;
  private batteryState: (EventTarget & { level: number; charging: boolean }) | null = null;
  private networkState: (EventTarget & { effectiveType?: string; saveData?: boolean }) | null = null;
  private inflightTasks = new Set<string>();
  /** Tasks the coordinator told us to stop; their failure must not be echoed back. */
  private abortedTasks = new Set<string>();
  private lightPreloader: LightPreloader | null = null;
  private preloaderTask: string | null = null;
  private swarmSessions = new Map<string, string>();
  private retiredSwarmSessions = new Set<string>();
  /**
   * Per-hop frame keys handed out with `swarm-slice`. A member signs what it
   * forwards with `outboundKey` and only accepts frames signed with
   * `inboundKey`, so one member cannot inject or rewrite a frame as another hop.
   */
  private swarmHopKeys = new Map<string, { inboundKey?: string; outboundKey?: string; chainLength: number }>();
  private swarmPeerTransports = new Map<string, SwarmPeerTransport>();
  private swarmPeerMetadata = new Map<string, { taskId: string; attemptId: string; peers: string[] }>();
  private swarmFailureReported = new Set<string>();
  /** Frame handling is serialized: HMAC verification and signing are async. */
  private swarmInboundChain: Promise<void> = Promise.resolve();
  private swarmOutboundChain: Promise<void> = Promise.resolve();
  /** Delivery attempt ids per task, echoed back so the coordinator can bind results. */
  private attempts = new Map<string, string>();
  /**
   * In-memory node token. Never persisted: a page reload simply re-registers,
   * which also rotates the token and keeps the server-issued node id current.
   */
  private cachedToken: NodeToken | null = null;

  private receiveSwarmEnvelope(buffer: ArrayBuffer) {
    const envelope = decodeSwarmEnvelope(buffer);
    if (!envelope || ![...this.swarmSessions.values()].includes(envelope.sessionId)) return;
    this.swarmInboundChain = this.swarmInboundChain
      .then(async () => {
        const keys = this.swarmHopKeys.get(envelope.sessionId);
        if (keys && keys.chainLength > 1) {
          if (!envelope.mac || !keys.inboundKey) return;
          const valid = await verifySwarmEnvelope(
            keys.inboundKey,
            envelope.sessionId,
            envelope.frame,
            envelope.mac,
          );
          if (!valid) {
            logError(`swarm frame rejected: bad hop MAC sessionId=${envelope.sessionId}`);
            return;
          }
        }
        this.workerPool.sendFrame(envelope.frame);
      })
      .catch(() => {});
  }

  private ensureSwarmPeerTransport(data: Record<string, unknown>) {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const taskId = typeof data.taskId === 'string' ? data.taskId : '';
    const attemptId = typeof data.attemptId === 'string' ? data.attemptId : '';
    if (!sessionId || !taskId || !attemptId || this.swarmPeerTransports.has(sessionId)) return;
    const previousNodeId = typeof data.previousNodeId === 'string' ? data.previousNodeId : undefined;
    const nextNodeId = typeof data.nextNodeId === 'string' ? data.nextNodeId : undefined;
    const peers = [...new Set([previousNodeId, nextNodeId].filter((id): id is string => !!id))];
    this.swarmPeerMetadata.set(sessionId, { taskId, attemptId, peers });
    const transport = new SwarmPeerTransport({
      sessionId,
      taskId,
      attemptId,
      nodeId: this.nodeId,
      previousNodeId,
      nextNodeId,
      onSignal: (toNodeId, signal) => this.send({
        type: 'swarm-peer-signal', taskId, sessionId, attemptId, toNodeId, signal,
      }),
      onFrame: (frame) => this.receiveSwarmEnvelope(frame),
      onQuality: (reports) => this.send({
        type: 'swarm-peer-quality', taskId, sessionId, attemptId, reports,
      }),
      onFailure: (error) => {
        this.swarmFailureReported.add(sessionId);
        this.send({ type: 'swarm-error', taskId, sessionId, attemptId, error: error.message });
      },
    });
    this.swarmPeerTransports.set(sessionId, transport);
    void transport.start();
  }

  private handleSwarmPeerSignal(data: Record<string, unknown>) {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const metadata = this.swarmPeerMetadata.get(sessionId);
    const transport = this.swarmPeerTransports.get(sessionId);
    if (!metadata || !transport || !isCurrentSwarmPeerSignal(data, {
      ...metadata,
      sessionId,
      nodeId: this.nodeId,
    })) return;
    void transport.handleSignal(data.fromNodeId as string, data.signal);
  }

  private retireSwarmSession(sessionId: string) {
    this.swarmHopKeys.delete(sessionId);
    this.swarmPeerTransports.get(sessionId)?.close();
    this.swarmPeerTransports.delete(sessionId);
    this.swarmPeerMetadata.delete(sessionId);
    this.swarmFailureReported.delete(sessionId);
    this.retiredSwarmSessions.add(sessionId);
    if (this.retiredSwarmSessions.size > 64) {
      this.retiredSwarmSessions.delete(this.retiredSwarmSessions.values().next().value!);
    }
  }

  constructor(
    private config: NodeConfig,
    private workerPool: WorkerPool,
    private nodeId: string,
  ) {}

  async connect() {
    if (this.destroyed) return;
    if (getConsentState() !== 'granted') {
      this.disconnect();
      return;
    }
    log(`connect nodeId=${this.nodeId}`);

    if (this.ws) {
      const old = this.ws;
      old.onclose = null;
      try {
        old.close();
      } catch {}
      this.ws = null;
    }

    this.setupMobileLifecycleHandlers();
    if (this.suspended) return;

    const token = await this.obtainToken();
    if (this.destroyed || this.suspended) return;
    if (getConsentState() !== 'granted') {
      log('connect cancelled because consent was revoked while obtaining a token');
      return;
    }
    if (!token) {
      logError('token acquisition failed; scheduling reconnect');
      this.scheduleReconnect();
      return;
    }
    // Light Inference: warm the translate model during idle time once the
    // node is connected. Consent is Crowd's consent (checked inside).
    this.startLightPreloader();

    // The token travels in the WebSocket subprotocol list: a browser cannot set
    // request headers, and a `?token=` query string would end up in proxy and
    // CDN access logs.
    const wsUrl = buildWsUrl(this.config.orchestratorUrl, '/crowd/signal');
    const ws = new WebSocket(wsUrl, buildNodeSignalProtocols(token.token));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.reconnectAttempts = 0;
      log(`signal connected ${wsUrl}`);
      void this.sendHeartbeat(ws);
    };

    ws.onmessage = async (event) => {
      if (this.ws !== ws) return;
      // Binary frames are swarm hidden states; hand them to the running worker
      // after checking their session envelope.
      if (typeof event.data !== 'string') {
        this.receiveSwarmEnvelope(event.data as ArrayBuffer);
        return;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (data.type === 'ping') {
        void this.sendHeartbeat(ws);
        return;
      }
      if (data.type === 'task') {
        const msg = data as unknown as TaskMessage;
        log(`task received taskId=${msg.taskId} workload=${msg.workload} timeoutMs=${msg.timeoutMs ?? 'default'}`);
        if (typeof msg.attemptId === 'string') this.attempts.set(msg.taskId, msg.attemptId);
        // Captured before the runner clears the map in its `finally`, so a
        // failure can still be reported against the delivery it belongs to.
        const attemptId = msg.attemptId ?? this.attempts.get(msg.taskId);
        try {
          await this.handleTask(msg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (this.abortedTasks.delete(msg.taskId)) {
            log(`task stopped on coordinator abort taskId=${msg.taskId} error=${message}`);
            return;
          }
          logError(`task failed taskId=${msg.taskId} workload=${msg.workload} error=${message}`);
          this.send({
            type: 'error',
            taskId: String(data.taskId ?? ''),
            error: message,
            attemptId,
          });
        }
        return;
      }
      if (data.type === 'swarm-init' || data.type === 'swarm-slice') {
        const taskId = String(data.taskId ?? '');
        if (!taskId) return;
        if (typeof data.sessionId !== 'string' || this.retiredSwarmSessions.has(data.sessionId)) return;
        if (data.type === 'swarm-slice') {
          this.ensureSwarmPeerTransport(data);
          this.swarmHopKeys.set(data.sessionId, {
            inboundKey: typeof data.inboundKey === 'string' ? data.inboundKey : undefined,
            outboundKey: typeof data.outboundKey === 'string' ? data.outboundKey : undefined,
            chainLength: typeof data.chainLength === 'number' ? data.chainLength : 1,
          });
        }
        // Only the host receives swarm-init, and only that delivery carries the
        // attempt id it must echo back when it settles the session.
        if (typeof data.attemptId === 'string') this.attempts.set(taskId, data.attemptId);
        // The host starts on swarm-init and a worker on its first swarm-slice;
        // a host's later slice just reaches the already-running worker.
        if (this.swarmSessions.get(taskId) === data.sessionId) {
          this.workerPool.sendControl(data, data.sessionId);
          return;
        }
        void this.startSwarm(taskId, data);
        return;
      }
      if (data.type === 'swarm-peer-signal') {
        this.handleSwarmPeerSignal(data);
        return;
      }
      if (data.type === 'swarm-transport') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const metadata = this.swarmPeerMetadata.get(sessionId);
        const transport = this.swarmPeerTransports.get(sessionId);
        if (
          metadata && transport &&
          data.taskId === metadata.taskId &&
          data.attemptId === metadata.attemptId &&
          (data.mode === 'peer' || data.mode === 'relay')
        ) transport.selectMode(data.mode);
        return;
      }
      if (data.type === 'swarm-flow') {
        const taskId = typeof data.taskId === 'string' ? data.taskId : '';
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const attemptId = typeof data.attemptId === 'string' ? data.attemptId : '';
        if (
          taskId && sessionId && this.swarmSessions.get(taskId) === sessionId &&
          this.attempts.get(taskId) === attemptId && typeof data.paused === 'boolean'
        ) this.workerPool.sendControl(data, sessionId);
        return;
      }
      if (data.type === 'task-flow') {
        const taskId = typeof data.taskId === 'string' ? data.taskId : '';
        const attemptId = typeof data.attemptId === 'string' ? data.attemptId : '';
        if (taskId && this.attempts.get(taskId) === attemptId && typeof data.paused === 'boolean') {
          this.workerPool.setTokenFlow(taskId, data.paused);
        }
        return;
      }
      if (data.type === 'swarm-start') {
        if (this.swarmSessions.get(String(data.taskId)) === data.sessionId) {
          this.workerPool.sendControl(data, data.sessionId as string);
        }
        return;
      }
      if (data.type === 'swarm-error') {
        // The coordinator rejected the session: fail it locally too, so this
        // node releases its slot instead of waiting out the task timeout.
        const taskId = String(data.taskId ?? '');
        if (taskId && this.swarmSessions.get(taskId) === data.sessionId) {
          this.workerPool.sendControl(data, data.sessionId as string);
        }
        return;
      }
      if (data.type === 'abort') {
        this.handleAbort(data);
        return;
      }
    };

    ws.onerror = () => {
      if (this.ws === ws) logError('signal websocket error');
    };

    ws.onclose = (event) => {
      ws.onclose = null;
      if (this.ws !== ws) return;
      this.ws = null;
      // A close before the handshake completed means the token was rejected
      // (expired, rotated, or the identity is gone): drop it so the next attempt
      // registers afresh instead of looping on a dead bearer.
      if (!opened) this.cachedToken = null;
      if (this.destroyed) return;
      log(`signal disconnected code=${event.code} reason=${JSON.stringify(event.reason)} clean=${event.wasClean}; scheduling reconnect attempt=${this.reconnectAttempts + 1}`);
      this.scheduleReconnect();
    };
  }

  /**
   * The coordinator settled this task (timeout, a peer failed, the plan was
   * rejected): stop it now instead of waiting out our own task timeout. The
   * failure is not reported back — the coordinator may already have requeued
   * the task for a retry, and an error echo would race that attempt.
   */
  private handleAbort(data: Record<string, unknown>) {
    const taskId = String(data.taskId ?? '');
    if (!taskId || !this.inflightTasks.has(taskId)) return;
    const error =
      typeof data.error === 'string' && data.error ? data.error : 'aborted by the coordinator';
    const sessionId = this.swarmSessions.get(taskId);
    if (sessionId && sessionId !== data.sessionId) return;
    const executionId = sessionId ?? taskId;
    if (sessionId) this.retireSwarmSession(sessionId);
    if (this.workerPool.abort(executionId, error)) this.abortedTasks.add(executionId);
    log(`task abort received taskId=${taskId} error=${error}`);
  }

  private async sendHeartbeat(ws: WebSocket) {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || getConsentState() !== 'granted') return;
    const requested = this.config.capabilities ?? ['ai-inference', 'image-process'];
    const probeGpu = requested.includes('swarm-inference') && this.config.allowModelDownload === true;
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const report = await collectNodeResourceReport({
      cpuLoad: this.workerPool.hasCpuLoadSample ? this.workerPool.lastCpuLoad : null,
      deviceMemory,
      probeGpu,
    });
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || getConsentState() !== 'granted') return;
    this.send({
      type: 'pong',
      cpuLoad: this.workerPool.hasCpuLoadSample ? this.workerPool.lastCpuLoad : null,
      resources: report,
      modelCache: this.workerPool.modelCacheSnapshot,
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.MAX_RECONNECT_DELAY);
    setTimeout(() => {
      if (this.destroyed || this.suspended) return;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  disconnect() {
    log(`disconnect nodeId=${this.nodeId}`);
    this.destroyed = true;
    this.suspended = false;
    this.stopLightPreloader();
    this.removeMobileLifecycleHandlers();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    for (const transport of this.swarmPeerTransports.values()) transport.close();
    this.swarmPeerTransports.clear();
    this.swarmPeerMetadata.clear();
    try {
      delete (window as any)[INIT_FLAG];
    } catch {}
    // Kill the Web Worker we own. Without this, a re-init (common on mobile
    // Chrome where the embed script re-executes) leaves the previous worker
    // running forever, and they accumulate into a huge worker swarm.
    try {
      this.workerPool.terminate();
    } catch {}
  }

  suspend() {
    if (this.suspended || this.destroyed) return;
    log('suspended (visibility or manual)');
    this.suspended = true;
    this.stopLightPreloader();
    if (this.ws) {
      const old = this.ws;
      old.onclose = null;
      try {
        old.close();
      } catch {}
      this.ws = null;
    }
    this.workerPool.terminate();
  }

  resume() {
    if (!this.suspended || this.destroyed) return;
    log('resumed');
    this.suspended = false;
    this.workerPool.resume();
    this.connect();
  }

  private async obtainToken(): Promise<NodeToken | null> {
    // Re-check consent after every await. Revocation can happen while a cached
    // token is being refreshed or while the capability probes/register request
    // are pending; a returned token must never establish a post-revoke socket.
    const consentStillGranted = () => getConsentState() === 'granted';
    if (!consentStillGranted()) return null;
    try {
      // Memory-only cache: the token is not written to localStorage, so a host
      // XSS cannot lift a node identity out of persistent storage.
      if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60000) {
        log(
          `token cached nodeId=${this.cachedToken.nodeId} expiresIn=${Math.round((this.cachedToken.expiresAt - Date.now()) / 1000)}s`,
        );
        return this.cachedToken;
      }

      // Gate heavy WASM workloads on a real measured allocation probe, not on
      // navigator.deviceMemory (which mobile Chrome reports quantized and is
      // therefore unsafe). Incapable devices still advertise light workloads
      // (for example cc-extract), so the orchestrator can use them without
      // risking a multi-GB allocation.
      const wasmMemoryBytes = probeMaxWasmMemoryBytes();
      const capable = wasmMemoryBytes >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES;
      const requested = this.config.capabilities ?? ['ai-inference', 'image-process'];
      let capabilities = [...requested];
      if (!capable) {
        capabilities = capabilities.filter((capability) => !HEAVY_WORKLOADS.has(capability));
      }
      if (validatedHttpsOrigins(this.config.containerImageOrigins).length === 0) {
        capabilities = capabilities.filter((cap) => cap !== 'container');
      }
      // Browser nodes cannot fetch Common Crawl ranges directly (CORS), so a
      // node without an allowlisted range proxy can never complete an
      // `cc-extract` task. Do not advertise the capability in that case.
      if (validatedHttpsOrigins(this.config.ccRangeOrigins).length === 0) {
        capabilities = capabilities.filter((cap) => cap !== 'cc-extract');
      }

      // Swarm inference additionally needs a working WebGPU device and an
      // explicit opt-in to download model layer weights. The resource report
      // includes a tiny bounded compute sample and is reused by heartbeats.
      let swarm: SwarmNodeCapabilities | undefined;
      if (capable && requested.includes('swarm-inference') && this.config.allowModelDownload === true) {
        const report = await collectNodeResourceReport({
          cpuLoad: this.workerPool.hasCpuLoadSample ? this.workerPool.lastCpuLoad : null,
          deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
          probeGpu: true,
        });
        if (!consentStillGranted()) return null;
        if (report.gpu.status === 'available') {
          swarm = { webgpu: true };
          if (report.gpu.architecture.value) swarm.gpuArchitecture = report.gpu.architecture.value;
          if (report.gpu.maxStorageBufferBindingSize.value !== null) {
            swarm.maxStorageBufferBindingSize = report.gpu.maxStorageBufferBindingSize.value;
          }
        } else {
          capabilities = capabilities.filter(cap => cap !== 'swarm-inference');
        }
      } else {
        capabilities = capabilities.filter(cap => cap !== 'swarm-inference');
      }

      log(
        `register capability probe capable=${capable} wasmMemoryBytes=${wasmMemoryBytes} capabilities=${JSON.stringify(capabilities)} webgpu=${swarm?.webgpu ?? false}`,
      );

      const base = this.config.orchestratorUrl.replace(/\/+$/, '');
      if (!consentStillGranted()) return null;
      const response = await fetch(`${base}/crowd/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: this.config.siteId,
          // No client-chosen nodeId: the coordinator always issues a fresh
          // random id and binds the token to it, so a node cannot claim another
          // node's identity (or displace a live socket).
          capabilities,
          // Only nodes with an explicit trusted-origin list can receive file refs.
          fileSources: validatedHttpsOrigins(this.config.fileSourceOrigins).length > 0,
          // Measured WASM memory the device could actually commit (bytes). The
          // orchestrator uses this to avoid routing heavy workloads to devices
          // that cannot run them.
          wasmMemoryBytes: probeMaxWasmMemoryBytes(),
          // Only defined on desktop Chrome; mobile WebViews report null so the
          // orchestrator never routes heavy WASM workloads to weak devices.
          deviceMemory:
            typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
              ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
              : null,
          swarm,
        }),
      });
      if (!consentStillGranted()) return null;
      if (!response.ok) {
        logError(`node register failed HTTP ${response.status} (${base}/crowd/nodes/register)`);
        return null;
      }

      const data = (await response.json()) as NodeToken;
      if (!consentStillGranted()) return null;
      if (!data.token) {
        logError('node register returned no token');
        return null;
      }

      // Adopt the server-issued identity. A locally generated id is only a log
      // label; the coordinator's id is the one the token is bound to.
      if (typeof data.nodeId === 'string' && data.nodeId) this.nodeId = data.nodeId;
      this.cachedToken = data;

      log(`node registered nodeId=${this.nodeId} expiresIn=${Math.round((data.expiresAt - Date.now()) / 1000)}s`);
      return data;
    } catch (err) {
      logError('node register threw', err instanceof Error ? err.message : err);
      return null;
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendBinary(frame: ArrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  /**
   * Sign an engine frame for the next hop and send it, in order. A multi-node
   * session without hop keys cannot produce a frame its neighbour would accept,
   * so it is dropped here instead of being sent unsigned.
   */
  private queueSwarmFrame(sessionId: string, frame: ArrayBuffer) {
    this.swarmOutboundChain = this.swarmOutboundChain
      .then(async () => {
        const keys = this.swarmHopKeys.get(sessionId);
        if (keys && keys.chainLength > 1) {
          if (!keys.outboundKey) {
            logError(`swarm frame not sent: no hop key sessionId=${sessionId}`);
            return;
          }
          const envelope = await signSwarmEnvelope(keys.outboundKey, sessionId, frame);
          const transport = this.swarmPeerTransports.get(sessionId);
          if (!transport || !await transport.sendFrame(envelope)) this.sendBinary(envelope);
          return;
        }
        const envelope = encodeSwarmEnvelope(sessionId, frame);
        const transport = this.swarmPeerTransports.get(sessionId);
        if (!transport || !await transport.sendFrame(envelope)) this.sendBinary(envelope);
      })
      .catch((error) => {
        const metadata = this.swarmPeerMetadata.get(sessionId);
        if (!metadata || this.swarmFailureReported.has(sessionId)) return;
        this.swarmFailureReported.add(sessionId);
        this.send({
          type: 'swarm-error',
          taskId: metadata.taskId,
          sessionId,
          attemptId: metadata.attemptId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Start a swarm session in the worker. The first control message is the task
   * payload; later control messages and binary frames are forwarded into the
   * running worker. The host's final result completes the task.
   */
  private async startSwarm(taskId: string, initial: Record<string, unknown>) {
    const sessionId = initial.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (this.swarmSessions.get(taskId) === sessionId) return;
    this.swarmSessions.set(taskId, sessionId);
    this.inflightTasks.add(taskId);
    const startedAt = performance.now();
    const timeoutMs = typeof initial.timeoutMs === 'number' ? initial.timeoutMs + 30000 : undefined;
    const attemptId = this.attempts.get(taskId);

    try {
      const result = await this.workerPool.run(
        sessionId,
        'swarm-inference',
        initial,
        timeoutMs,
        (token: string) => {
          this.send({ type: 'progress', taskId, sessionId, token, attemptId });
        },
        { maxCpuLoad: this.effectiveMaxCpuLoad() },
        {
          onFrame: (frame) => this.queueSwarmFrame(sessionId, frame),
          // Attempt ids are transport metadata owned by this client, so stamp
          // them onto the engine's control messages (swarm-token / swarm-done):
          // the coordinator only accepts session messages from the host attempt.
          onMessage: (message) => {
            const outgoing = message && typeof message === 'object' && !('attemptId' in message)
              ? { ...message, attemptId }
              : (message as Record<string, unknown>);
            if (outgoing?.type === 'swarm-ready') {
              const transport = this.swarmPeerTransports.get(sessionId);
              void (async () => {
                const peerReady = transport ? await transport.waitUntilReady() : false;
                this.send({ ...outgoing, peerReady });
              })();
              return;
            }
            this.send(outgoing);
          },
        },
      );
      if (!this.abortedTasks.delete(sessionId)) {
        this.send({ type: 'result', taskId, sessionId, payload: result, attemptId });
      }
      log(
        `swarm result sent taskId=${taskId} durationMs=${Math.round(performance.now() - startedAt)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.abortedTasks.delete(sessionId)) {
        log(`swarm stopped on coordinator abort taskId=${taskId} error=${message}`);
      } else {
        logError(`swarm failed taskId=${taskId} error=${message}`);
        this.send({ type: 'error', taskId, sessionId, error: message, attemptId });
      }
    } finally {
      this.retireSwarmSession(sessionId);
      if (this.swarmSessions.get(taskId) === sessionId) {
        this.swarmSessions.delete(taskId);
        this.inflightTasks.delete(taskId);
        this.attempts.delete(taskId);
      }
    }
  }

  private async handleTask(data: TaskMessage) {
    // A task is delivered at-least-once: if the coordinator restarts/redelivers
    // a task this node is still working on, don't execute it a second time.
    if (this.inflightTasks.has(data.taskId)) return;
    this.inflightTasks.add(data.taskId);
    const startedAt = performance.now();
    const attemptId = data.attemptId ?? this.attempts.get(data.taskId);
    try {
      const timeoutMs = data.timeoutMs ? data.timeoutMs + 30000 : undefined;
      const result = await this.workerPool.run(
        data.taskId,
        data.workload,
        data.payload,
        timeoutMs,
        (token: string) => {
          this.send({ type: 'progress', taskId: data.taskId, token, attemptId });
        },
        {
          maxCpuLoad: this.effectiveMaxCpuLoad(),
          fileSourceOrigins: validatedHttpsOrigins(this.config.fileSourceOrigins),
          containerImageOrigins: validatedHttpsOrigins(this.config.containerImageOrigins),
          ccRangeOrigins: validatedHttpsOrigins(this.config.ccRangeOrigins),
        },
      );
      this.send({ type: 'result', taskId: data.taskId, payload: result, attemptId });
      log(
        `task result sent taskId=${data.taskId} workload=${data.workload} durationMs=${Math.round(performance.now() - startedAt)}`,
      );
    } finally {
      this.inflightTasks.delete(data.taskId);
      this.attempts.delete(data.taskId);
    }
  }

  /**
   * Run `ai-inference` locally without involving the orchestrator.
   * Light Inference entry point for SPA callers: the same payload shape as a
   * coordinator task, executed in this device's WorkerPool.
   *
   * When the caller passes `options.ondeviceOnly === true` and the model is
   * not held, the worker fails with `ONDEVICE_UNAVAILABLE` (500) and nothing
   * is delegated. Without a running node the same 500 is thrown here.
   */
  async runLocalAiInference(
    payload: AiInferencePayload,
    onToken?: (token: string) => void | Promise<void>,
  ): Promise<AiInferenceResult> {
    if (!this.workerPool) {
      throw new OndeviceUnavailableError('No running Crowd node on this device', 'node_not_running');
    }
    // Consent is the gate: a local inference is still running a Crowd node.
    if (getConsentState() !== 'granted') {
      throw new OndeviceUnavailableError('Crowd consent is not granted', 'consent_not_granted');
    }
    const id = `local-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
    const result = await this.workerPool.run(id, 'ai-inference', payload, 300000, onToken, {
      maxCpuLoad: this.effectiveMaxCpuLoad(),
      fileSourceOrigins: validatedHttpsOrigins(this.config.fileSourceOrigins),
      containerImageOrigins: validatedHttpsOrigins(this.config.containerImageOrigins),
    });
    return result as AiInferenceResult;
  }

  /** Route a preload through the worker's `preloadAiModel` snapshot check. */
  isAiModelPreloaded(model: string | { model: string; dtype?: string; device?: string }): boolean {
    // Cheap signal via the heartbeat snapshot: a ready entry counts.
    const snapshot = this.workerPool.modelCacheSnapshot;
    if (!snapshot) return false;
    if (typeof model === 'string') {
      return snapshot.entries.some((e) => e.modelId === model && e.state === 'ready');
    }
    const wantDtype = model.dtype ?? 'q4f16';
    const wantBackend = (model.device ?? 'wasm') as 'wasm' | 'cpu' | 'webgpu';
    return snapshot.entries.some(
      (e) =>
        e.modelId === model.model && e.dtype === wantDtype && e.backend === wantBackend && e.state === 'ready',
    );
  }

  /** Warm a model in the worker (Light Inference idle preload). */
  async preloadAiModel(request: { task: string; model: string; dtype?: string; device?: string }): Promise<void> {
    const id = `preload-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
    await this.workerPool.run(
      id,
      'ai-preload' as unknown as WorkloadType,
      request,
      300000,
      undefined,
      { maxCpuLoad: this.effectiveMaxCpuLoad() },
    );
  }

  private startLightPreloader(): void {
    if (this.lightPreloader) this.lightPreloader.stop();
    this.lightPreloader = new LightPreloader(
      () => getConsentState(),
      {
        targets: [
          {
            model: LIGHT_INFERENCE_TRANSLATE_MODEL,
            task: LIGHT_INFERENCE_TRANSLATE_TASK,
            dtype: LIGHT_INFERENCE_TRANSLATE_DTYPE,
          },
          {
            model: LIGHT_INFERENCE_PLAMO_TRANSLATE_MODEL,
            task: LIGHT_INFERENCE_PLAMO_TRANSLATE_TASK,
            dtype: LIGHT_INFERENCE_PLAMO_TRANSLATE_DTYPE,
          },
        ],
        onPreloaded: () => { /* status chip refresh hook for host diagnostics */ },
      },
      (target) => this.isAiModelPreloaded({ model: target.model, dtype: target.dtype }),
      (request) => this.preloadAiModel(request),
    );
    this.lightPreloader.start();
  }

  private stopLightPreloader(): void {
    if (this.lightPreloader) this.lightPreloader.stop();
    this.lightPreloader = null;
  }

  private listenForLifecycle(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.lifecycleCleanup.push(() => target.removeEventListener(type, listener));
  }

  private setupMobileLifecycleHandlers() {
    this.removeMobileLifecycleHandlers();
    const epoch = this.lifecycleEpoch;
    this.lifecyclePageHidden = document.hidden;
    this.lifecycleOffline = navigator.onLine === false;
    const nav = navigator as Navigator & {
      connection?: EventTarget & { effectiveType?: string; saveData?: boolean };
      getBattery?: () => Promise<EventTarget & { level: number; charging: boolean }>;
    };
    this.networkState = nav.connection ?? null;

    this.listenForLifecycle(document, 'visibilitychange', () => {
      this.lifecyclePageHidden = document.hidden;
      this.refreshMobileLifecycle();
    });
    this.listenForLifecycle(window, 'offline', () => {
      this.lifecycleOffline = true;
      this.refreshMobileLifecycle();
    });
    this.listenForLifecycle(window, 'online', () => {
      this.lifecycleOffline = false;
      this.refreshMobileLifecycle();
    });
    this.listenForLifecycle(window, 'pagehide', () => {
      this.lifecyclePageHidden = true;
      this.refreshMobileLifecycle();
    });
    this.listenForLifecycle(window, 'pageshow', () => {
      this.lifecyclePageHidden = false;
      this.refreshMobileLifecycle();
    });
    if (this.networkState) {
      this.listenForLifecycle(this.networkState, 'change', () => this.refreshMobileLifecycle());
    }

    if (typeof nav.getBattery === 'function') {
      try {
        void nav.getBattery.call(navigator).then((battery) => {
          if (this.destroyed || epoch !== this.lifecycleEpoch) return;
          this.batteryState = battery;
          const update = () => this.refreshMobileLifecycle();
          this.listenForLifecycle(battery, 'levelchange', update);
          this.listenForLifecycle(battery, 'chargingchange', update);
          this.refreshMobileLifecycle();
        }).catch(() => {
          // The Battery Status API is optional and unavailable in several mobile browsers.
        });
      } catch {
        // Some browsers expose getBattery but reject direct calls by policy.
      }
    }
    this.refreshMobileLifecycle();
  }

  private removeMobileLifecycleHandlers() {
    this.lifecycleEpoch++;
    for (const cleanup of this.lifecycleCleanup.splice(0)) cleanup();
    this.batteryState = null;
    this.networkState = null;
  }

  private mobileLifecycleDecision() {
    return evaluateMobileLifecycle({
      hidden: document.hidden,
      pageHidden: this.lifecyclePageHidden,
      online: !this.lifecycleOffline && navigator.onLine !== false,
      batteryLevel: this.batteryState?.level,
      batteryCharging: this.batteryState?.charging,
      effectiveType: this.networkState?.effectiveType,
      saveData: this.networkState?.saveData,
    }, this.config.maxCpuLoad);
  }

  private effectiveMaxCpuLoad() {
    return this.mobileLifecycleDecision().maxCpuLoad;
  }

  private refreshMobileLifecycle() {
    const decision = this.mobileLifecycleDecision();
    if (decision.suspend) {
      this.suspend();
    } else if (this.suspended) {
      this.resume();
    }
  }
}

const WINDOW_KEY = '__flaxia_node_signal_client';
const INIT_FLAG = '__flaxia_node_init_started';
const CONTROLLER_KEY = '__flaxia_node_controller';

const startNode = (config: NodeConfig) => {
  // Defence in depth for issue #7/#9: whatever path got here, the device only
  // joins the crowd with a granted consent record. A host-managed accept() that
  // the consent store refused (no real user gesture) therefore leaves the node
  // idle instead of connecting for this page view.
  if (getConsentState() !== 'granted') {
    logError('refusing to start the node without a granted consent record');
    return;
  }

  const prev: SignalingClient | undefined = (window as any)[WINDOW_KEY];
  if (prev) {
    prev.disconnect();
  }

  // Purge a token persisted by an older bundle: the bearer is memory-only now.
  safeLocalStorageRemove(NODE_TOKEN_KEY);

  const workerUrl = new URL('./worker.js', import.meta.url).href;
  const workerPool = new WorkerPool(workerUrl);
  let nodeId = safeLocalStorageGet(NODE_ID_KEY);
  if (!nodeId) {
    nodeId = safeRandomUUID();
    safeLocalStorageSet(NODE_ID_KEY, nodeId);
  }

  const client = new SignalingClient(config, workerPool, nodeId);
  (window as any)[WINDOW_KEY] = client;
  client.connect();
};

/**
 * Owns the node lifecycle and consent persistence. A single controller is
 * cached on `window` so a host (e.g. a settings screen) can start/stop the
 * node and flip consent without re-importing the bundle.
 */
class NodeController implements FlaxiaNodeController {
  constructor(private config: NodeConfig) {}

  start(): void {
    if (this.isRunning() || !hasConsent()) return;
    startNode(this.config);
  }

  stop(): void {
    const client: SignalingClient | undefined = (window as any)[WINDOW_KEY];
    if (client) {
      client.disconnect();
    }
    // disconnect() leaves the handle in place for the old embed contract, so
    // clear it here to make isRunning() truthful and allow a clean restart.
    delete (window as any)[WINDOW_KEY];
    delete (window as any)[INIT_FLAG];
  }

  isRunning(): boolean {
    return Boolean((window as any)[WINDOW_KEY]);
  }

  getConsentState(): ConsentState {
    return getConsentState();
  }

  grant(): void {
    saveConsent();
  }

  deny(): void {
    saveDenial();
    this.stop();
    // Drop the cached orchestrator token so a denied node does not silently
    // resume with a stale identity.
    safeLocalStorageRemove(NODE_TOKEN_KEY);
  }

  clearConsent(): void {
    clearPersistedConsent();
    this.stop();
    safeLocalStorageRemove(NODE_TOKEN_KEY);
  }

  async runLocalAiInference(
    payload: AiInferencePayload,
    onToken?: (token: string) => void | Promise<void>,
  ): Promise<AiInferenceResult> {
    const client: SignalingClient | undefined = (window as any)[WINDOW_KEY];
    if (!client || !this.isRunning()) {
      throw new OndeviceUnavailableError('No running Crowd node on this device', 'node_not_running');
    }
    return client.runLocalAiInference(payload, onToken);
  }

  isAiModelPreloaded(model: string): boolean {
    const client: SignalingClient | undefined = (window as any)[WINDOW_KEY];
    if (!client) return false;
    return client.isAiModelPreloaded(model);
  }

  async preloadAiModel(request: { task: string; model: string; dtype?: string; device?: string }): Promise<void> {
    const client: SignalingClient | undefined = (window as any)[WINDOW_KEY];
    if (!client) {
      throw new OndeviceUnavailableError('No running Crowd node on this device', 'node_not_running');
    }
    await client.preloadAiModel(request);
  }
}

export const initFlaxiaNode = (config: NodeConfig): FlaxiaNodeController => {
  // Idempotent: the embed script can be re-executed on mobile Chrome (background
  // tab revival, SPA navigations, duplicate injection). Re-running must never
  // spin up additional Web Workers / SignalClients, so the cached controller is
  // returned as-is.
  const existing: NodeController | undefined = (window as any)[CONTROLLER_KEY];
  if (existing) return existing;

  const controller = new NodeController(config);
  (window as any)[CONTROLLER_KEY] = controller;
  (window as any)[INIT_FLAG] = true;

  const state = getConsentState();
  if (state === 'granted') {
    controller.start();
    return controller;
  }
  if (state === 'denied') {
    return controller;
  }

  // State is 'unset'. Delegate to the host when it provides its own UI,
  // otherwise fall back to the built-in banner for third-party embeds.
  if (config.consent.onConsentRequired) {
    config.consent.onConsentRequired({
      state,
      accept: () => {
        saveConsent();
        controller.start();
      },
      reject: () => {
        saveDenial();
      },
    });
    return controller;
  }

  const container = document.createElement('div');
  container.id = 'flaxia-consent-container';
  document.body.appendChild(container);

  new ConsentUI(
    container,
    config.consent,
    () => {
      saveConsent();
      container.remove();
      controller.start();
    },
    () => {
      saveDenial();
      container.remove();
    },
  );

  return controller;
};
