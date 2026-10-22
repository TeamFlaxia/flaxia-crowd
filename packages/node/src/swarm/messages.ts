import {
  isSwarmErrorMessage,
  isSwarmFlowMessage,
  isSwarmInitMessage,
  isSwarmSliceMessage,
  isSwarmStartMessage,
  isSwarmTransportMessage,
  type SwarmErrorMessage,
  type SwarmFlowMessage,
  type SwarmInitMessage,
  type SwarmSliceMessage,
  type SwarmStartMessage,
  type SwarmTransportMessage,
} from '@flaxia/sdk';

/** Swarm control messages the coordinator sends to a node. */
export type SwarmControlMessage =
  | SwarmInitMessage
  | SwarmSliceMessage
  | SwarmStartMessage
  | SwarmErrorMessage
  | SwarmFlowMessage
  | SwarmTransportMessage;

/** Messages from the main thread into the swarm worker. */
export type SwarmWorkerInbound =
  | { id: string; type: 'swarm-control'; message: SwarmControlMessage }
  | { id: string; type: 'swarm-frame'; frame: ArrayBuffer };

/** Messages the swarm worker sends back to the main thread. */
export type SwarmWorkerOutbound =
  | { id: string; type: 'swarm-message'; message: unknown }
  | { id: string; type: 'swarm-frame'; frame: ArrayBuffer };

/**
 * Structural validation for every control message a node accepts. The SDK
 * validators check the fields the node relies on (slice bounds, chain position,
 * hop keys, ids), so a malformed or hostile message is dropped before it can
 * reach the engine or the layer loader.
 */
export function isSwarmControlMessage(value: unknown): value is SwarmControlMessage {
  return (
    isSwarmInitMessage(value) ||
    isSwarmSliceMessage(value) ||
    isSwarmStartMessage(value) ||
    isSwarmTransportMessage(value) ||
    isSwarmFlowMessage(value) ||
    isSwarmErrorMessage(value)
  );
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
