import type { WorkloadType } from './types';

/**
 * Every workload defined by the protocol. This mirrors the {@link WorkloadType}
 * union and is the single source of truth for runtime validation of untrusted
 * input. Keep it in sync with `types.ts`.
 */
export const WORKLOAD_TYPES = [
  'ai-inference',
  'image-process',
  'file-convert',
  'container',
  'vector-embed',
  'vector-store',
  'vector-query',
  'moe-inference',
  'nudenet',
] as const satisfies readonly WorkloadType[];

/**
 * Workloads that are implemented end-to-end (node executor + orchestrator
 * routing) and therefore safe for the orchestrator to enqueue. `moe-inference`
 * is declared in the protocol but has no node implementation yet, so it is
 * deliberately excluded.
 */
export const ROUTABLE_WORKLOADS = [
  'ai-inference',
  'image-process',
  'file-convert',
  'container',
  'vector-embed',
  'vector-store',
  'vector-query',
  'nudenet',
] as const satisfies readonly WorkloadType[];

/**
 * Heavy WebAssembly workloads that can exhaust memory on constrained devices.
 * The orchestrator must not route these to low-memory nodes, and nodes gate
 * them behind a real `WebAssembly.Memory` probe before advertising support.
 */
export const HEAVY_WORKLOADS: ReadonlySet<WorkloadType> = new Set<WorkloadType>([
  'ai-inference',
  'image-process',
  'container',
  'vector-embed',
  'vector-query',
  'nudenet',
]);

/** Default per-workload task timeout in milliseconds. */
export const DEFAULT_WORKLOAD_TIMEOUT_MS: Readonly<Record<WorkloadType, number>> = {
  'ai-inference': 600_000,
  'image-process': 120_000,
  'file-convert': 120_000,
  container: 300_000,
  'vector-embed': 600_000,
  'vector-store': 60_000,
  'vector-query': 60_000,
  'moe-inference': 600_000,
  nudenet: 120_000,
};

/** Narrowing guard for untrusted input (HTTP bodies, postMessage, storage). */
export function isWorkloadType(value: unknown): value is WorkloadType {
  return typeof value === 'string' && (WORKLOAD_TYPES as readonly string[]).includes(value);
}

/** Whether the orchestrator can currently enqueue this workload. */
export function isRoutableWorkload(value: unknown): value is WorkloadType {
  return typeof value === 'string' && (ROUTABLE_WORKLOADS as readonly string[]).includes(value);
}

export function isHeavyWorkload(workload: string): boolean {
  return HEAVY_WORKLOADS.has(workload as WorkloadType);
}

/** Resolve the timeout a host should request for a workload when none is given. */
export function defaultTimeoutFor(workload: WorkloadType): number {
  return DEFAULT_WORKLOAD_TIMEOUT_MS[workload] ?? 60_000;
}