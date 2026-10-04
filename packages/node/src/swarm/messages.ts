import type {
  SwarmErrorMessage,
  SwarmInitMessage,
  SwarmRole,
  SwarmSlice,
  SwarmSliceMessage,
  SwarmStartMessage,
} from '@flaxia/sdk';

/** Swarm control messages the coordinator sends to a node. */
export type SwarmControlMessage = SwarmInitMessage | SwarmSliceMessage | SwarmStartMessage | SwarmErrorMessage;

/**
 * Shape of a coordinator-supplied layer slice. Mirrors the (unexported) `isSlice`
 * guard in `@flaxia/sdk`; kept local so the node can reject a forged slice even
 * when the SDK is consumed from a built bundle.
 */
export function isSwarmSlice(value: unknown): value is SwarmSlice {
  if (!value || typeof value !== 'object') return false;
  const slice = value as { start?: unknown; end?: unknown; hasEmbed?: unknown; hasHead?: unknown };
  return (
    typeof slice.start === 'number' &&
    typeof slice.end === 'number' &&
    typeof slice.hasEmbed === 'boolean' &&
    typeof slice.hasHead === 'boolean'
  );
}

/** What this node's place in the chain says the slice must look like. */
export interface SwarmSliceExpectations {
  /** This node's role; index 0 is the host. */
  role?: SwarmRole;
  /** This node's chain position (0 = host). */
  index?: number;
  /** Number of nodes in the chain, including this one. */
  chainLength?: number;
  /** Trunk layer count of the model, when the runtime could resolve it. */
  totalLayers?: number;
}

/**
 * Why `slice` cannot be this node's slice, or `null` when it could be.
 *
 * The slice is coordinator-supplied input: `start`/`end` become the engine's
 * layer range and `hasEmbed`/`hasHead` decide whether it builds the embedding
 * and the LM head, so a forged slice could make a node read weights (and write
 * GPU buffers) outside the plan the host agreed to. Every invariant that a
 * `buildSwarmChain` output satisfies is checked, against the model's real layer
 * count whenever the runtime can resolve it.
 */
export function findSwarmSliceProblem(slice: unknown, expectations: SwarmSliceExpectations = {}): string | null {
  if (!isSwarmSlice(slice)) return 'slice must declare numeric start/end and boolean hasEmbed/hasHead';
  const { start, end, hasEmbed, hasHead } = slice;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return `slice bounds must be integers, got ${start}..${end}`;
  if (start < 0) return `slice start ${start} is negative`;
  if (end <= start) return `slice ${start}..${end} is empty`;
  // `buildSwarmChain` hands the embedding and the LM head to the host together,
  // and only to the host, whose slice always starts at layer 0.
  if (hasEmbed !== hasHead) return 'slice must own the embedding and the LM head together';
  if (hasEmbed !== (start === 0)) return `slice ${start}..${end} must not own the embedding/head (only a slice starting at 0 does)`;

  const { role, index, chainLength, totalLayers } = expectations;
  if (role !== undefined && role !== 'host' && role !== 'worker') return `unknown role ${JSON.stringify(role)}`;
  if (chainLength !== undefined) {
    if (!Number.isInteger(chainLength) || chainLength < 1) {
      return `chainLength ${JSON.stringify(chainLength)} is not a positive integer`;
    }
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= chainLength)) {
      return `index ${JSON.stringify(index)} is outside a chain of ${chainLength}`;
    }
  }
  if (role !== undefined && index !== undefined && role !== (index === 0 ? 'host' : 'worker')) {
    return `role ${role} does not match chain index ${index}`;
  }
  if (totalLayers !== undefined) {
    if (!Number.isInteger(totalLayers) || totalLayers < 1) {
      return `the model has no trunk layers (${JSON.stringify(totalLayers)})`;
    }
    if (end > totalLayers) return `slice end ${end} is beyond the model's ${totalLayers} trunk layers`;
    // Only a host that is the whole chain may hold every layer; with peers in
    // the chain there would be nothing left for them.
    if (chainLength !== undefined && chainLength > 1 && start === 0 && end === totalLayers) {
      return 'a host sharing the chain cannot hold every layer';
    }
  }
  return null;
}

/** Messages from the main thread into the swarm worker. */
export type SwarmWorkerInbound =
  | { id: string; type: 'swarm-control'; message: SwarmControlMessage }
  | { id: string; type: 'swarm-frame'; frame: ArrayBuffer };

/** Messages the swarm worker sends back to the main thread. */
export type SwarmWorkerOutbound =
  | { id: string; type: 'swarm-message'; message: unknown }
  | { id: string; type: 'swarm-frame'; frame: ArrayBuffer };

export function isSwarmControlMessage(value: unknown): value is SwarmControlMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'swarm-init' || type === 'swarm-slice' || type === 'swarm-start' || type === 'swarm-error';
}

export function isSwarmFrameMessage(value: unknown): value is { id: string; type: 'swarm-frame'; frame: ArrayBuffer } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; frame?: unknown; id?: unknown };
  return record.type === 'swarm-frame' && typeof record.id === 'string' && record.frame instanceof ArrayBuffer;
}

export function isSwarmControlEnvelope(
  value: unknown,
): value is { id: string; type: 'swarm-control'; message: SwarmControlMessage } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { type?: unknown; id?: unknown; message?: unknown };
  return record.type === 'swarm-control' && typeof record.id === 'string' && isSwarmControlMessage(record.message);
}
