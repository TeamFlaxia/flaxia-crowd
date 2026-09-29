import { SwarmEngineUnavailableError } from './adapter';
import type { SwarmRuntime } from './controller';

/**
 * Production model access for swarm slices.
 *
 * Not implemented yet: it must fetch the GGUF header to learn the layer count,
 * plan the split, then range-fetch and cache this node's own layer byte spans
 * before creating the engine slice. Until then the swarm controller reports a
 * clean engine-unavailable error instead of failing deep in a generation loop.
 *
 * `swarm-inference` is intentionally still absent from `ROUTABLE_WORKLOADS`, so
 * no live task reaches this path.
 */
export function createSwarmRuntime(): SwarmRuntime {
  const unavailable = async (): Promise<never> => {
    throw new SwarmEngineUnavailableError('swarm model loading is not implemented yet');
  };
  return {
    plan: unavailable,
    load: unavailable,
  };
}
