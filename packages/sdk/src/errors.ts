export class FlaxiaError extends Error {
  constructor(public message: string, public code: string, public status?: number) {
    super(message);
    this.name = 'FlaxiaError';
  }
}

export class AuthenticationError extends FlaxiaError {
  constructor(message = 'Invalid API Key') {
    super(message, 'AUTH_ERROR', 401);
  }
}

export class TaskNotFoundError extends FlaxiaError {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`, 'TASK_NOT_FOUND', 404);
  }
}

export class ValidationError extends FlaxiaError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

/**
 * `ondeviceOnly: true` was requested but no runnable node holds the model.
 * Status 500 by design: the caller explicitly forbids delegation/download,
 * so the only honest answer is an immediate failure, never a queue wait.
 */
export class OndeviceUnavailableError extends FlaxiaError {
  constructor(message = 'On-device model not available', detail?: string) {
    super(detail ? `${message}: ${detail}` : message, 'ONDEVICE_UNAVAILABLE', 500);
    if (detail) (this as unknown as { detail?: string }).detail = detail;
  }
}
