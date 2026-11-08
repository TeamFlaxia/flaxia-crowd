import { describe, expect, it } from 'vitest';
import { isSupportedSwarmModelId, SUPPORTED_SWARM_MODEL_IDS } from '../swarm-models';

describe('swarm model allowlist', () => {
  it('accepts only the browser runtime model ids', () => {
    for (const modelId of SUPPORTED_SWARM_MODEL_IDS) expect(isSupportedSwarmModelId(modelId)).toBe(true);
    expect(isSupportedSwarmModelId('custom-model')).toBe(false);
    expect(isSupportedSwarmModelId('https://example.com/model.gguf')).toBe(false);
    expect(isSupportedSwarmModelId(null)).toBe(false);
  });
});
