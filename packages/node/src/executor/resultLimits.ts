/**
 * Bound on a task result accepted from the worker.
 *
 * This matches the orchestrator's `MAX_RESULT_BYTES` (4 MiB) so the node fails
 * a task locally instead of structured-cloning and JSON-serializing a result
 * the coordinator would reject anyway.
 */
export const MAX_TASK_RESULT_BYTES = 4 * 1024 * 1024;

/**
 * Upper bound on the UTF-8 bytes `JSON.stringify` produces for a string,
 * including its two quotes. A BMP code point takes up to 3 UTF-8 bytes;
 * a surrogate pair takes 4 bytes for two code units (still under the 3/unit
 * estimate). Control characters and lone surrogates are escaped to six bytes,
 * so those code units carry a 3-byte surcharge.
 */
function estimateJsonStringBytes(value: string, cap = Number.POSITIVE_INFINITY): number {
  let total = 2; // surrounding quotes
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    total += 3;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // a valid pair is 4 bytes, below the 2 * 3 already counted
        continue;
      }
    }
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) total += 3;
    if (total > cap) return total;
  }
  return total;
}

/**
 * Estimate the serialized size of a result without building the JSON string.
 *
 * `JSON.stringify` on a large result doubles the peak (the result plus its
 * serialized copy). This walks the value and returns as soon as the estimate
 * exceeds `cap`, so an oversized result is rejected cheaply. The estimate is
 * always >= the real UTF-8 byte count of the serialized result, which is the
 * unit the coordinator's `MAX_RESULT_BYTES` budget is measured in.
 */
export function estimateSerializedBytes(value: unknown, cap: number = MAX_TASK_RESULT_BYTES): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateJsonStringBytes(value, cap);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 24;
  if (typeof value === 'function' || typeof value === 'symbol') return 0;
  if (Array.isArray(value)) {
    let total = 8;
    for (const item of value) {
      total += 1 + estimateSerializedBytes(item, cap); // comma + value
      if (total > cap) return total;
    }
    return total;
  }
  if (typeof value === 'object') {
    let total = 8;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += 1 + estimateJsonStringBytes(key, cap) + 1 + estimateSerializedBytes(item, cap); // comma + key + colon
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
