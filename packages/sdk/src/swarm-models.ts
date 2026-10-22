/** Swarm models the browser runtime can download and execute. */
export const SUPPORTED_SWARM_MODEL_IDS = [
  'qwen3.5-2b',
  'qwen3.8-27b',
  'qwen3.6-35b-moe',
] as const;

export type SupportedSwarmModelId = (typeof SUPPORTED_SWARM_MODEL_IDS)[number];

const supportedSwarmModels = new Set<string>(SUPPORTED_SWARM_MODEL_IDS);

export function isSupportedSwarmModelId(value: unknown): value is SupportedSwarmModelId {
  return typeof value === 'string' && supportedSwarmModels.has(value);
}
