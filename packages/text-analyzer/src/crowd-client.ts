import type { SubmitTaskOptions, SubmitTaskResponse, TaskRecord } from '@flaxia/sdk';

function apiBase(): string {
  // Browser code never holds the Crowd API key. The hosting layer must proxy
  // /crowd/* to the orchestrator and attach Authorization server-side.
  return window.location.origin;
}

async function extractError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {}
  return response.statusText || 'Crowd request failed';
}

export async function submitCrowdTask(options: SubmitTaskOptions): Promise<SubmitTaskResponse> {
  const response = await fetch(`${apiBase()}/crowd/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) throw new Error(await extractError(response));
  return response.json() as Promise<SubmitTaskResponse>;
}

export async function getCrowdTask(taskId: string): Promise<TaskRecord> {
  const response = await fetch(`${apiBase()}/crowd/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw new Error(await extractError(response));
  return response.json() as Promise<TaskRecord>;
}
