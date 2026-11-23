/**
 * Errors that will fail the same way on every retry.
 *
 * The coordinator retries transient failures (timeouts, disconnects) up to
 * `MAX_RETRIES`, so a deterministic validation or capability error must be
 * marked permanent or it burns every placement before reaching the caller.
 */
export class PermanentTaskError extends Error {
  readonly code: string;

  constructor(message: string, code = 'TASK_PERMANENT') {
    super(message);
    this.name = 'PermanentTaskError';
    this.code = code;
  }
}

export function isPermanentTaskError(error: unknown): boolean {
  return error instanceof PermanentTaskError;
}
