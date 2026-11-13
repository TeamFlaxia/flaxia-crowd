/**
 * Bound on a task result accepted from the worker.
 *
 * This matches the orchestrator's `MAX_RESULT_BYTES` (4 MiB) so the node fails
 * a task locally instead of structured-cloning and JSON-serializing a result
 * the coordinator would reject anyway.
 */
export const MAX_TASK_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * Estimate the serialized size of a result without building the JSON string.
 *
 * `JSON.stringify` on a large result doubles the peak (the result plus its
 * serialized copy). This walks the value and returns as soon as the estimate
 * exceeds `cap`, so an oversized result is rejected cheaply.
 */
export function estimateSerializedBytes(value: unknown, cap: number = MAX_TASK_RESULT_BYTES): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 16;
  if (typeof value === 'function' || typeof value === 'symbol') return 0;
  if (Array.isArray(value)) {
    let total = 8;
    for (const item of value) {
      total += estimateSerializedBytes(item, cap);
      if (total > cap) return total;
    }
    return total;
  }
  if (typeof value === 'object') {
    let total = 8;
    for (const item of Object.values(value as Record<string, unknown>)) {
      total += estimateSerializedBytes(item, cap);
      if (total > cap) return total;
    }
    return total;
  }
  return 0;
}

/** Whether a result is small enough to post back to the main thread. */
export function isResultWithinLimit(value: unknown, cap: number = MAX_TASK_RESULT_BYTES): boolean {
  return estimateSerializedBytes(value, cap) <= cap;
}
