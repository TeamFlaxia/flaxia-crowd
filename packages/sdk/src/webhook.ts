import type { TaskRecord, TaskStatus } from './types';

/**
 * Terminal task status as delivered to a host via HTTP callback (webhook).
 * Non-terminal states are never sent, so the callback contract is narrower than
 * the full {@link TaskStatus}.
 */
export type CrowdCallbackStatus = Extract<TaskStatus, 'done' | 'failed'>;

/**
 * The orchestrator's callback body. Note the shape mirrors {@link TaskRecord}
 * for `result`/`error` but only carries the fields a host needs to react.
 */
export interface CrowdWebhookEvent<TResult = unknown> {
  taskId: string;
  status: CrowdCallbackStatus;
  /**
   * Orchestrator result envelope. The workload's own payload lives under
   * `result.output`; some workloads also place it at the top level of `result`.
   */
  result?: { output?: TResult; [key: string]: unknown };
  error?: string;
}

/**
 * Validate and normalize an untrusted webhook body. Returns `null` when the
 * payload is not a well-formed crowd callback so callers can safely `400`.
 */
export function parseCrowdWebhook<TResult = unknown>(body: unknown): CrowdWebhookEvent<TResult> | null {
  if (!body || typeof body !== 'object') return null;

  const record = body as Record<string, unknown>;
  const taskId = record.taskId;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;

  const status = record.status;
  if (status !== 'done' && status !== 'failed') return null;

  const event: CrowdWebhookEvent<TResult> = { taskId, status };

  if (record.result && typeof record.result === 'object') {
    event.result = record.result as CrowdWebhookEvent<TResult>['result'];
  }
  if (typeof record.error === 'string') {
    event.error = record.error;
  }

  return event;
}

/**
 * Extract the workload payload from a callback result. Workloads historically
 * disagree on nesting, so hosts should use this instead of poking at the raw
 * envelope: it prefers `result.output` and falls back to `result` itself.
 */
export function extractCallbackOutput<TResult = unknown>(
  event: CrowdWebhookEvent<TResult>,
): TResult | undefined {
  const result = event.result;
  if (!result) return undefined;
  if (result.output !== undefined) return result.output;
  return result as TResult;
}

export interface CallbackUrlOptions {
  /** Host base URL, e.g. `https://flaxia.app`. Trailing slashes are tolerated. */
  baseUrl: string;
  /** Callback path on the host. Defaults to `/api/crowd/webhook`. */
  path?: string;
  /** Discriminator for the completed workload, placed in the `type` param. */
  type: string;
  /** Extra query params. `undefined`, `null` and `''` values are skipped. */
  params?: Record<string, string | number | undefined | null>;
}

/**
 * Build the `callbackUrl` a host passes to {@link import('./client').FlaxiaClient.submit}.
 * Centralizes URL shape so every host integration produces identical callbacks.
 */
export function buildCallbackUrl(options: CallbackUrlOptions): string {
  const base = options.baseUrl.replace(/\/+$/, '');
  const path = options.path ?? '/api/crowd/webhook';
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);

  url.searchParams.set('type', options.type);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/** Read the workload discriminator out of a callback request URL. */
export function callbackTypeFromUrl(url: URL | string): string | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.searchParams.get('type');
}

/** Type guard for full task records returned by the polling API. */
export function isTerminalTask(task: Pick<TaskRecord, 'status'>): boolean {
  return task.status === 'done' || task.status === 'failed';
}