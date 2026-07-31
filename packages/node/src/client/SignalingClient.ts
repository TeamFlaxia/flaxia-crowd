import { ConsentUI } from '../consent/ConsentUI';
import { hasConsent, saveConsent } from '../consent/storage';
import { WorkerPool } from '../executor/WorkerPool';

import type { NodeConfig, WorkloadType } from '@flaxia/sdk';

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

  constructor(
    private config: NodeConfig,
    private workerPool: WorkerPool,
    private nodeId: string,
  ) {}

  async connect() {
    if (this.destroyed) return;

    if (this.ws) {
      const old = this.ws;
      old.onclose = null;
      try { old.close(); } catch {}
      this.ws = null;
    }

    this.setupVisibilityHandler();

    const token = await this.obtainToken();
    if (!token) {
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
        try {
          await this.handleTask(data as unknown as TaskMessage);
        } catch (err) {
          this.send({
            type: 'error',
            taskId: String(data.taskId ?? ''),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    ws.onclose = () => {
      ws.onclose = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.destroyed) return;
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
    this.destroyed = true;
    this.suspended = false;
    this.removeVisibilityHandler();
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }

  suspend() {
    if (this.suspended || this.destroyed) return;
    this.suspended = true;
    if (this.ws) {
      const old = this.ws;
      old.onclose = null;
      try { old.close(); } catch {}
      this.ws = null;
    }
    this.workerPool.terminate();
  }

  resume() {
    if (!this.suspended || this.destroyed) return;
    this.suspended = false;
    this.workerPool.resume();
    this.connect();
  }

  private async obtainToken(): Promise<NodeToken | null> {
    try {
      const cachedRaw = localStorage.getItem(NODE_TOKEN_KEY);
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw) as NodeToken;
          if (cached.token && cached.nodeId && cached.expiresAt > Date.now() + 60000) {
            return cached;
          }
        } catch {}
      }

      const base = this.config.orchestratorUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/crowd/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId: this.config.siteId,
          nodeId: this.nodeId,
          capabilities: this.config.capabilities ?? ['ai-inference', 'image-process'],
        }),
      });
      if (!response.ok) return null;

      const data = (await response.json()) as NodeToken;
      if (!data.token) return null;

      try {
        localStorage.setItem(NODE_TOKEN_KEY, JSON.stringify(data));
      } catch {}
      return data;
    } catch {
      return null;
    }
  }

  private send(message: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private async handleTask(data: TaskMessage) {
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

const startNode = (config: NodeConfig) => {
  const prev: SignalingClient | undefined = (window as any)[WINDOW_KEY];
  if (prev) {
    prev.disconnect();
  }

  const workerUrl = new URL('./worker.js', import.meta.url).href;
  const workerPool = new WorkerPool(workerUrl);
  let nodeId = localStorage.getItem(NODE_ID_KEY);
  if (!nodeId) {
    nodeId = crypto.randomUUID();
    localStorage.setItem(NODE_ID_KEY, nodeId);
  }

  const client = new SignalingClient(config, workerPool, nodeId);
  (window as any)[WINDOW_KEY] = client;
  client.connect();
};

export const initFlaxiaNode = (config: NodeConfig) => {
  if (hasConsent()) {
    startNode(config);
    return;
  }

  const container = document.createElement('div');
  container.id = 'flaxia-consent-container';
  document.body.appendChild(container);

  const ui = new ConsentUI(container, config.consent, () => {
    saveConsent();
    container.remove();
    startNode(config);
  });
};
