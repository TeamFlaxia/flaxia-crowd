import { ConsentUI } from '../consent/ConsentUI';
import {
  clearConsent as clearPersistedConsent,
  getConsentState,
  saveConsent,
  saveDenial,
  safeLocalStorageGet,
  safeLocalStorageRemove,
  safeLocalStorageSet,
  safeRandomUUID,
} from '../consent/storage';
import { WorkerPool } from '../executor/WorkerPool';
import { HEAVY_WORKLOAD_WASM_MEMORY_BYTES, probeMaxWasmMemoryBytes } from '../executor/memoryProbe';
import { probeWebGpu } from '../executor/webgpuProbe';

import type { ConsentState, FlaxiaNodeController, NodeConfig, SwarmNodeCapabilities, WorkloadType } from '@flaxia/sdk';

const log = (...args: unknown[]) => console.log('[flaxia-node]', ...args);
const logError = (...args: unknown[]) => console.error('[flaxia-node]', ...args);

export interface TaskMessage {
  type: 'task';
  taskId: string;
  workload: WorkloadType;
  payload: unknown;
  timeoutMs?: number;
}

interface NodeToken {
  token: string;
  nodeId: string;
  expiresAt: number;
}

const NODE_ID_KEY = 'flaxia_node_id';
const NODE_TOKEN_KEY = 'flaxia_node_token';

class SignalingClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30000;
  private destroyed = false;
  private suspended = false;
  private visibilityHandler: (() => void) | null = null;
  private inflightTasks = new Set<string>();

  constructor(
    private config: NodeConfig,
    private workerPool: WorkerPool,
    private nodeId: string,
  ) {}

  async connect() {
    if (this.destroyed) return;
    log(`connect nodeId=${this.nodeId}`);

    if (this.ws) {
      const old = this.ws;
      old.onclose = null;
      try {
        old.close();
      } catch {}
      this.ws = null;
    }

    this.setupVisibilityHandler();

    const token = await this.obtainToken();
    if (!token) {
      logError('token acquisition failed; scheduling reconnect');
      this.scheduleReconnect();
      return;
    }

    const wsBase = this.config.orchestratorUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
    const wsUrl = new URL(`${wsBase}/crowd/signal`);
    wsUrl.searchParams.set('token', token.token);

    const ws = new WebSocket(wsUrl.toString());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      log(`signal connected ${wsUrl.toString()}`);
    };

    ws.onmessage = async (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (data.type === 'ping') {
        this.send({ type: 'pong', cpuLoad: this.workerPool.lastCpuLoad });
        return;
      }
      if (data.type === 'task') {
        const msg = data as unknown as TaskMessage;
        log(`task received taskId=${msg.taskId} workload=${msg.workload} timeoutMs=${msg.timeoutMs ?? 'default'}`);
        try {
          await this.handleTask(msg);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`task failed taskId=${msg.taskId} workload=${msg.workload} error=${message}`);
          this.send({
            type: 'error',
            taskId: String(data.taskId ?? ''),
            error: message,
          });
        }
      }
    };

    ws.onclose = () => {
      ws.onclose = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.destroyed) return;
      log(`signal disconnected; scheduling reconnect attempt=${this.reconnectAttempts + 1}`);
      this.scheduleReconnect();
    };
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
    this.removeVisibilityHandler();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
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
    try {
      const cachedRaw = safeLocalStorageGet(NODE_TOKEN_KEY);
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw) as NodeToken;
          if (cached.token && cached.nodeId && cached.expiresAt > Date.now() + 60000) {
            log(
              `token cached nodeId=${cached.nodeId} expiresIn=${Math.round((cached.expiresAt - Date.now()) / 1000)}s`,
            );
            return cached;
          }
        } catch {}
      }

      // Gate heavy WASM workloads on a real measured allocation probe, not on
      // navigator.deviceMemory (which mobile Chrome reports quantized and is
      // therefore unsafe). If the device cannot actually commit the memory a
      // multi-GB model needs, advertise NO capabilities so the orchestrator
      // routes every task elsewhere.
      const wasmMemoryBytes = probeMaxWasmMemoryBytes();
      const capable = wasmMemoryBytes >= HEAVY_WORKLOAD_WASM_MEMORY_BYTES;
      const requested = this.config.capabilities ?? ['ai-inference', 'image-process'];
      let capabilities = capable ? [...requested] : [];

      // Swarm inference additionally needs WebGPU and an explicit opt-in to
      // download multi-GB layer weights. Probe only when the host asked for it,
      // and drop the capability when the device cannot actually serve it.
      let swarm: SwarmNodeCapabilities | undefined;
      if (capable && requested.includes('swarm-inference') && this.config.allowModelDownload === true) {
        swarm = await probeWebGpu();
        if (!swarm.webgpu) {
          capabilities = capabilities.filter(cap => cap !== 'swarm-inference');
          swarm = undefined;
        }
      } else {
        capabilities = capabilities.filter(cap => cap !== 'swarm-inference');
      }

      log(
        `register capability probe capable=${capable} wasmMemoryBytes=${wasmMemoryBytes} capabilities=${JSON.stringify(capabilities)} webgpu=${swarm?.webgpu ?? false}`,
      );

      const base = this.config.orchestratorUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/crowd/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: this.config.siteId,
          nodeId: this.nodeId,
          capabilities,
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
      if (!response.ok) {
        logError(`node register failed HTTP ${response.status} (${base}/crowd/nodes/register)`);
        return null;
      }

      const data = (await response.json()) as NodeToken;
      if (!data.token) {
        logError('node register returned no token');
        return null;
      }

      log(`node registered nodeId=${this.nodeId} expiresIn=${Math.round((data.expiresAt - Date.now()) / 1000)}s`);
      try {
        safeLocalStorageSet(NODE_TOKEN_KEY, JSON.stringify(data));
      } catch {}
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

  private async handleTask(data: TaskMessage) {
    // A task is delivered at-least-once: if the coordinator restarts/redelivers
    // a task this node is still working on, don't execute it a second time.
    if (this.inflightTasks.has(data.taskId)) return;
    this.inflightTasks.add(data.taskId);
    const startedAt = performance.now();
    try {
      const timeoutMs = data.timeoutMs ? data.timeoutMs + 30000 : undefined;
      const result = await this.workerPool.run(
        data.taskId,
        data.workload,
        data.payload,
        timeoutMs,
        (token: string) => {
          this.send({ type: 'progress', taskId: data.taskId, token });
        },
        { maxCpuLoad: this.config.maxCpuLoad },
      );
      this.send({ type: 'result', taskId: data.taskId, payload: result });
      log(
        `task result sent taskId=${data.taskId} workload=${data.workload} durationMs=${Math.round(performance.now() - startedAt)}`,
      );
    } finally {
      this.inflightTasks.delete(data.taskId);
    }
  }

  private setupVisibilityHandler() {
    this.removeVisibilityHandler();
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.suspend();
      } else if (this.suspended) {
        this.resume();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private removeVisibilityHandler() {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}

const WINDOW_KEY = '__flaxia_node_signal_client';
const INIT_FLAG = '__flaxia_node_init_started';
const CONTROLLER_KEY = '__flaxia_node_controller';

const startNode = (config: NodeConfig) => {
  const prev: SignalingClient | undefined = (window as any)[WINDOW_KEY];
  if (prev) {
    prev.disconnect();
  }

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
    if (this.isRunning()) return;
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
