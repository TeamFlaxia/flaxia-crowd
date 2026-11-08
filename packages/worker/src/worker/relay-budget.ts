/** Per-task ceiling for bytes sent through the Coordinator's WebSocket relay. */
export const MAX_SWARM_RELAY_BYTES_PER_TASK = 256 * 1024 * 1024;

export function swarmRelayBudgetKey(taskId: string): string {
  return `swarm-relay-bytes:${taskId}`;
}

/** Atomically reserve one frame against a cumulative task budget. */
export function reserveSwarmRelayBytes(
  usedBytes: number,
  frameBytes: number,
  limitBytes = MAX_SWARM_RELAY_BYTES_PER_TASK,
): number | null {
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 ||
      !Number.isSafeInteger(frameBytes) || frameBytes < 1 ||
      !Number.isSafeInteger(limitBytes) || limitBytes < 1 ||
      usedBytes > limitBytes || frameBytes > limitBytes - usedBytes) return null;
  return usedBytes + frameBytes;
}
