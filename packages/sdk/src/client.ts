import type { TaskPayload, WorkloadType, TaskRecord, SubmitTaskResponse, TaskQueueStats, TaskStreamReset } from './types';
import { AuthenticationError, FlaxiaError, TaskNotFoundError, ValidationError } from './errors';
import { SUBSCRIBE_PROTOCOL, buildSubscribeProtocols, buildWsUrl } from './handshake';
import { MAX_SDK_BUFFERED_TOKENS, MAX_SDK_BUFFERED_TOKEN_CHARS } from './flow-control';
import { MAX_SWARM_NODES, MIN_SWARM_NODES } from './swarm';
import { isSupportedSwarmModelId, type SupportedSwarmModelId } from './swarm-models';

export interface FlaxiaClientConfig {
  apiKey: string;
  /** Orchestrator root URL, e.g. 'https://api.flaxia.crowd' or 'https://host/crowd'. */
  baseUrl?: string;
}

export interface SubmitTaskOptions {
  workload: WorkloadType;
  payload: TaskPayload;
  callbackUrl?: string;
  timeoutMs?: number;
  /** Scheduling class from 0 (background) through 3 (interactive). */
  priority?: 0 | 1 | 2 | 3;
}

export interface SwarmPrewarmOptions {
  model: SupportedSwarmModelId;
  minNodes?: number;
  maxNodes?: number;
}

export interface TaskSubscription {
  onToken: (callback: (token: string) => void | Promise<void>) => void;
  /** Clear accumulated output when a retry restarts from the prompt. */
  onReset: (callback: (reset: TaskStreamReset) => void | Promise<void>) => void;
  onDone: (callback: (result: unknown) => void) => void;
  onError: (callback: (error: string) => void) => void;
  close: () => void;
}

export interface SubscribeOptions {
  /**
   * Pre-fetched subscribe token. When omitted the client reuses the token from
   * `submit()` or fetches one with `GET /crowd/tasks/:id` (owner-only).
   */
  subscribeToken?: string;
}

/** How long before expiry a cached subscribe token is refreshed. */
const SUBSCRIBE_TOKEN_SKEW_MS = 30_000;

/**
 * Normalizes a base URL so the SDK can be configured with either the host root
 * ('https://host') or a '/crowd'-prefixed URL, while all requests consistently
 * target the worker's actual routes ('/crowd/tasks', '/crowd/subscribe').
 */
function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (base.endsWith('/crowd')) {
    base = base.slice(0, -'/crowd'.length);
  }
  return base;
}

export class FlaxiaClient {
  private apiKey: string;
  private baseUrl: string;
  private subscribeTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(config: FlaxiaClientConfig) {
    if (!config.apiKey) {
      throw new AuthenticationError('API Key is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl || 'https://api.flaxia.crowd');
  }

  async submit(options: SubmitTaskOptions): Promise<SubmitTaskResponse> {
    if (!options.workload || !options.payload) {
      throw new ValidationError('workload and payload are required');
    }

    const body: Record<string, unknown> = {
      workload: options.workload,
      payload: options.payload,
    };
    if (options.callbackUrl) body.callbackUrl = options.callbackUrl;
    if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs;
    if (options.priority !== undefined) {
      if (!Number.isInteger(options.priority) || options.priority < 0 || options.priority > 3) {
        throw new ValidationError('priority must be an integer between 0 and 3');
      }
      body.priority = options.priority;
    }

    const response = await fetch(`${this.baseUrl}/crowd/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const message = await this.extractError(response);
      throw new FlaxiaError(message, 'SUBMIT_ERROR', response.status);
    }

    const result = await response.json() as SubmitTaskResponse;
    this.rememberSubscribeToken(result.taskId ?? result.id, result.subscribeToken, result.subscribeTokenExpiresAt);
    return result;
  }

  async getTask(taskId: string): Promise<TaskRecord> {
    const response = await fetch(`${this.baseUrl}/crowd/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (response.status === 404) {
      throw new TaskNotFoundError(taskId);
    }

    if (!response.ok) {
      const message = await this.extractError(response);
      throw new FlaxiaError(message, 'FETCH_ERROR', response.status);
    }

    const task = await response.json() as TaskRecord;
    this.rememberSubscribeToken(taskId, task.subscribeToken, task.subscribeTokenExpiresAt);
    return task;
  }

  /** Read queue wait and fairness counters for this API key's tenant only. */
  async getQueueStats(): Promise<TaskQueueStats> {
    const response = await fetch(`${this.baseUrl}/crowd/queue/stats`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      const message = await this.extractError(response);
      throw new FlaxiaError(message, 'QUEUE_STATS_ERROR', response.status);
    }
    return response.json() as Promise<TaskQueueStats>;
  }

  /**
   * Run one bounded real inference to populate consenting nodes' persistent
   * browser weight caches. Returns the ordinary task id for status polling.
   */
  async prewarmSwarmModel(options: SwarmPrewarmOptions): Promise<SubmitTaskResponse> {
    if (!options || !isSupportedSwarmModelId(options.model)) {
      throw new ValidationError('model is not in the supported swarm model list');
    }
    const minNodes = options.minNodes ?? MIN_SWARM_NODES;
    const maxNodes = options.maxNodes ?? Math.max(minNodes, 4);
    if (!Number.isInteger(minNodes) || minNodes < MIN_SWARM_NODES || minNodes > MAX_SWARM_NODES ||
        !Number.isInteger(maxNodes) || maxNodes < minNodes || maxNodes > MAX_SWARM_NODES) {
      throw new ValidationError(`minNodes/maxNodes must be integers between ${MIN_SWARM_NODES} and ${MAX_SWARM_NODES}`);
    }
    const response = await fetch(`${this.baseUrl}/crowd/swarm/prewarm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: options.model, minNodes, maxNodes }),
    });
    if (!response.ok) {
      const message = await this.extractError(response);
      throw new FlaxiaError(message, 'PREWARM_ERROR', response.status);
    }
    return response.json() as Promise<SubmitTaskResponse>;
  }

  async waitForTask(taskId: string, intervalMs = 2000, timeoutMs = 60000): Promise<TaskRecord> {
    const start = Date.now();

    const ws = await Promise.race([
      this.subscribe(taskId).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), intervalMs)),
    ]);

    if (ws) {
      // This caller wants the terminal record, so consume and acknowledge
      // streamed tokens to keep the producer moving.
      ws.onToken(() => {});
      return await Promise.race([
        this.pollUntilDone(taskId, intervalMs, timeoutMs, start),
        new Promise<TaskRecord>((resolve, reject) => {
          const remaining = timeoutMs - (Date.now() - start);
          if (remaining <= 0) {
            reject(new FlaxiaError('Task polling timed out', 'POLLING_TIMEOUT', 408));
            return;
          }

          const timer = setTimeout(() => {
            reject(new FlaxiaError('Task polling timed out', 'POLLING_TIMEOUT', 408));
          }, remaining);

          const finish = async () => {
            clearTimeout(timer);
            ws.close();
            try {
              resolve(await this.getTask(taskId));
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          };

          ws.onDone(finish);
          ws.onError(finish);
        }),
      ]);
    }

    return this.pollUntilDone(taskId, intervalMs, timeoutMs, start);
  }

  private async pollUntilDone(
    taskId: string, intervalMs: number, timeoutMs: number, start: number
  ): Promise<TaskRecord> {
    while (Date.now() - start < timeoutMs) {
      const task = await this.getTask(taskId);
      if (task.status === 'done' || task.status === 'failed') return task;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new FlaxiaError('Task polling timed out', 'POLLING_TIMEOUT', 408);
  }

  /**
   * Stream a task's tokens and terminal result.
   *
   * `/crowd/subscribe` requires a short-lived token bound to the task, so the
   * client resolves one automatically: the token returned by `submit()`, the
   * cached one from a previous `getTask()`, or a fresh `GET /crowd/tasks/:id`
   * with the API key. Pass `options.subscribeToken` to override.
   */
  async subscribe(taskId: string, options: SubscribeOptions = {}): Promise<TaskSubscription> {
    const token = options.subscribeToken ?? await this.resolveSubscribeToken(taskId);
    if (!token) {
      throw new FlaxiaError(
        'A subscribe token is required for /crowd/subscribe',
        'SUBSCRIBE_UNAUTHORIZED',
        401,
      );
    }

    const url = buildWsUrl(this.baseUrl, '/crowd/subscribe', { taskId });
    const ws = new WebSocket(url, buildSubscribeProtocols(token));

    let tokenCallback: ((token: string) => void | Promise<void>) | null = null;
    let resetCallback: ((reset: TaskStreamReset) => void | Promise<void>) | null = null;
    let doneCallback: ((result: unknown) => void) | null = null;
    let errorCallback: ((error: string) => void) | null = null;
    type StreamEvent =
      | { type: 'token'; token: string; sequence?: number }
      | { type: 'reset'; epoch: number }
      | { type: 'done'; result: unknown }
      | { type: 'error'; error: string };
    const pendingEvents: StreamEvent[] = [];
    let pendingTokenCount = 0;
    let pendingTokenChars = 0;
    let drainingTokens = false;
    let pendingError: string | null = null;

    const reportError = (message: string) => {
      pendingEvents.length = 0;
      pendingTokenCount = 0;
      pendingTokenChars = 0;
      if (errorCallback) errorCallback(message);
      else pendingError = message;
    };

    const drainTokens = async () => {
      if (drainingTokens) return;
      drainingTokens = true;
      try {
        while (pendingEvents.length > 0) {
          const item = pendingEvents[0];
          if (item.type === 'token' && !tokenCallback) break;
          if (item.type === 'reset' && !resetCallback && !tokenCallback && !doneCallback) break;
          if (item.type === 'done' && !doneCallback) break;
          if (item.type === 'error' && !errorCallback) break;
          pendingEvents.shift();
          if (item.type === 'token') {
            pendingTokenCount--;
            pendingTokenChars -= item.token.length;
            await tokenCallback!(item.token);
            if (item.sequence !== undefined && (ws as WebSocket).readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ack', sequence: item.sequence }));
            }
          } else if (item.type === 'reset') {
            await resetCallback?.({ epoch: item.epoch });
          } else if (item.type === 'done') {
            doneCallback!(item.result);
          } else {
            errorCallback!(item.error);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Token consumer failed';
        reportError(message);
        try { ws.close(1011, 'token consumer failed'); } catch {}
      } finally {
        drainingTokens = false;
      }
    };

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        // The coordinator only pauses generation for clients that explicitly
        // support per-token acknowledgements. Older SDKs remain bounded by the
        // server's legacy in-flight token ceiling.
        ws.send(JSON.stringify({ type: 'flow-control', version: 1 }));
        resolve({
          onToken: (cb) => { tokenCallback = cb; void drainTokens(); },
          onReset: (cb) => { resetCallback = cb; void drainTokens(); },
          onDone: (cb) => { doneCallback = cb; void drainTokens(); },
          onError: (cb) => {
            errorCallback = cb;
            if (pendingError) {
              const message = pendingError;
              pendingError = null;
              cb(message);
            }
            void drainTokens();
          },
          close: () => { pendingEvents.length = 0; pendingTokenCount = 0; pendingTokenChars = 0; ws.close(); },
        });
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (pendingEvents.length >= MAX_SDK_BUFFERED_TOKENS + 8) {
            reportError('Task stream consumer is too slow; subscription was closed');
            ws.close(1013, 'slow task stream consumer');
            return;
          }
          if (msg.type === 'token') {
            if (typeof msg.token !== 'string' || msg.token.length > 4096) {
              reportError('Task stream returned an invalid token');
              ws.close(1009, 'invalid token');
              return;
            }
            const sequence = Number.isSafeInteger(msg.sequence) && msg.sequence > 0 ? msg.sequence as number : undefined;
            if (pendingTokenCount >= MAX_SDK_BUFFERED_TOKENS || pendingTokenChars + msg.token.length > MAX_SDK_BUFFERED_TOKEN_CHARS) {
              reportError('Task stream consumer is too slow; subscription was closed');
              ws.close(1013, 'slow task stream consumer');
              return;
            }
            pendingEvents.push({ type: 'token', token: msg.token, sequence });
            pendingTokenCount++;
            pendingTokenChars += msg.token.length;
            void drainTokens();
          } else if (msg.type === 'reset' && Number.isSafeInteger(msg.epoch) && msg.epoch >= 0) {
            pendingEvents.push({ type: 'reset', epoch: msg.epoch });
            void drainTokens();
          } else if (msg.type === 'done') {
            pendingEvents.push({ type: 'done', result: msg.result });
            void drainTokens();
          } else if (msg.type === 'error' && typeof msg.error === 'string') {
            pendingEvents.push({ type: 'error', error: msg.error });
            void drainTokens();
          }
        } catch {}
      };

      ws.onerror = () => {
        reject(new FlaxiaError('WebSocket connection failed', 'WS_CONNECT_ERROR', 0));
      };
    });
  }

  /** Cached-or-fetched subscribe token; `null` when the server did not issue one. */
  private async resolveSubscribeToken(taskId: string): Promise<string | null> {
    const cached = this.subscribeTokens.get(taskId);
    if (cached && cached.expiresAt - SUBSCRIBE_TOKEN_SKEW_MS > Date.now()) {
      return cached.token;
    }
    const task = await this.getTask(taskId);
    return task.subscribeToken ?? null;
  }

  private rememberSubscribeToken(taskId: string | undefined, token?: string, expiresAt?: number): void {
    if (!taskId || !token) return;
    // Without a server-provided expiry, assume the documented 10 minute TTL.
    this.subscribeTokens.set(taskId, { token, expiresAt: expiresAt ?? Date.now() + 10 * 60_000 });
    if (this.subscribeTokens.size > 64) {
      const oldest = this.subscribeTokens.keys().next().value;
      if (oldest !== undefined) this.subscribeTokens.delete(oldest);
    }
  }

  private async extractError(response: Response): Promise<string> {
    try {
      const data = await response.json();
      if (data && typeof data.error === 'string' && data.error) return data.error;
    } catch {}
    return response.statusText || 'Request failed';
  }
}
