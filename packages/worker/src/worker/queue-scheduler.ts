export type TaskPriority = 0 | 1 | 2 | 3;

export interface PendingTaskSummary {
  id: string;
  tenantId: string;
  createdAt: number;
  priority?: number;
}

export const TASK_PRIORITY_MIN = 0;
export const TASK_PRIORITY_MAX = 3;
export const TASK_PRIORITY_DEFAULT: TaskPriority = 1;
export const TASK_AGING_INTERVAL_MS = 30_000;
export const TASK_EFFECTIVE_PRIORITY_MAX = 12;
export const TENANT_WEIGHT_MIN = 1;
export const TENANT_WEIGHT_MAX = 4;

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= TASK_PRIORITY_MIN && value <= TASK_PRIORITY_MAX;
}

/** Invalid operator configuration safely falls back to equal tenant weights. */
export function parseTenantSchedulingWeights(raw?: string): Record<string, number> {
  if (!raw || raw.length > 16_384) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const weights: Record<string, number> = {};
    for (const [tenantId, value] of Object.entries(parsed)) {
      if (!tenantId || tenantId.length > 128 || typeof value !== 'number' || !Number.isInteger(value) ||
          value < TENANT_WEIGHT_MIN || value > TENANT_WEIGHT_MAX) continue;
      weights[tenantId] = value;
    }
    return weights;
  } catch {
    return {};
  }
}

export interface PendingQueueOrder {
  ordered: PendingTaskSummary[];
  nextTenantCursor: string | null;
}

/**
 * Sort bounded pending work by aged priority, then weighted round-robin among
 * tenants in the same effective-priority band. Older tasks win within a tenant.
 */
export function orderPendingTasks(
  tasks: readonly PendingTaskSummary[],
  now: number,
  tenantWeights: Readonly<Record<string, number>> = {},
  tenantCursor: string | null = null,
): PendingQueueOrder {
  const byPriority = new Map<number, Map<string, PendingTaskSummary[]>>();
  const allTenants = [...new Set(tasks.map((task) => task.tenantId))].sort();

  for (const task of tasks) {
    const rawPriority = isTaskPriority(task.priority) ? task.priority : TASK_PRIORITY_DEFAULT;
    const waitedMs = Number.isFinite(task.createdAt) ? Math.max(0, now - task.createdAt) : 0;
    const effectivePriority = Math.min(
      TASK_EFFECTIVE_PRIORITY_MAX,
      rawPriority + Math.floor(waitedMs / TASK_AGING_INTERVAL_MS),
    );
    const tenantTasks = byPriority.get(effectivePriority) ?? new Map<string, PendingTaskSummary[]>();
    const queue = tenantTasks.get(task.tenantId) ?? [];
    queue.push(task);
    tenantTasks.set(task.tenantId, queue);
    byPriority.set(effectivePriority, tenantTasks);
  }

  const ordered: PendingTaskSummary[] = [];
  const priorities = [...byPriority.keys()].sort((a, b) => b - a);
  for (const priority of priorities) {
    const queues = byPriority.get(priority)!;
    for (const queue of queues.values()) {
      queue.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    const tenants = [...queues.keys()].sort();
    if (tenantCursor && tenants.includes(tenantCursor)) {
      const cursorIndex = tenants.indexOf(tenantCursor);
      tenants.push(...tenants.splice(0, cursorIndex));
    }

    let hasWork = true;
    while (hasWork) {
      hasWork = false;
      for (const tenantId of tenants) {
        const queue = queues.get(tenantId)!;
        const requestedWeight = tenantWeights[tenantId];
        const weight = Number.isInteger(requestedWeight)
          ? Math.max(TENANT_WEIGHT_MIN, Math.min(TENANT_WEIGHT_MAX, requestedWeight!))
          : TENANT_WEIGHT_MIN;
        for (let slot = 0; slot < weight && queue.length; slot++) {
          ordered.push(queue.shift()!);
          hasWork = true;
        }
      }
    }
  }

  if (!allTenants.length) return { ordered, nextTenantCursor: null };
  const cursorIndex = tenantCursor ? allTenants.indexOf(tenantCursor) : -1;
  const nextTenantCursor = allTenants[(cursorIndex + 1) % allTenants.length];
  return { ordered, nextTenantCursor };
}
