import type { TaskPayload, WorkloadType, TaskRecord, SubmitTaskResponse } from './types';
import { AuthenticationError, FlaxiaError, TaskNotFoundError, ValidationError } from './errors';

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
}

export interface TaskSubscription {
  onToken: (callback: (token: string) => void) => void;
  onDone: (callback: (result: unknown) => void) => void;
  onError: (callback: (error: string) => void) => void;
  close: () => void;
}

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

function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws');
}

export class FlaxiaClient {
  private apiKey: string;
  private baseUrl: string;

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

    return response.json() as Promise<SubmitTaskResponse>;
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

    return response.json() as Promise<TaskRecord>;
  }

  async waitForTask(taskId: string, intervalMs = 2000, timeoutMs = 60000): Promise<TaskRecord> {
    const start = Date.now();

    const ws = await Promise.race([
      this.subscribe(taskId).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), intervalMs)),
    ]);

    if (ws) {
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

  async subscribe(taskId: string): Promise<TaskSubscription> {
    const ws = new WebSocket(`${toWsUrl(this.baseUrl)}/crowd/subscribe?taskId=${taskId}`);

    let tokenCallback: ((token: string) => void) | null = null;
    let doneCallback: ((result: unknown) => void) | null = null;
    let errorCallback: ((error: string) => void) | null = null;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve({
          onToken: (cb) => { tokenCallback = cb; },
          onDone: (cb) => { doneCallback = cb; },
          onError: (cb) => { errorCallback = cb; },
          close: () => { ws.close(); },
        });
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === 'token' && tokenCallback) {
            tokenCallback(msg.token);
          } else if (msg.type === 'done' && doneCallback) {
            doneCallback(msg.result);
          } else if (msg.type === 'error' && errorCallback) {
            errorCallback(msg.error);
          }
        } catch {}
      };

      ws.onerror = () => {
        reject(new FlaxiaError('WebSocket connection failed', 'WS_CONNECT_ERROR', 0));
      };
    });
  }

  private async extractError(response: Response): Promise<string> {
    try {
      const data = await response.json();
      if (data && typeof data.error === 'string' && data.error) return data.error;
    } catch {}
    return response.statusText || 'Request failed';
  }
}
