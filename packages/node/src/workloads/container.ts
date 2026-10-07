import { runContainer } from '../executor/container-executor';
import type { ContainerPayload, ContainerResult } from '@flaxia/sdk';

export const handleContainer = async (
  payload: ContainerPayload,
  fileSourceOrigins: readonly string[] = [],
  containerImageOrigins?: readonly string[],
): Promise<ContainerResult> => {
  const startedAt = performance.now();
  try {
    const result = await runContainer(payload, fileSourceOrigins, containerImageOrigins);
    console.log(
      `[flaxia-node] container: done durationMs=${Math.round(performance.now() - startedAt)} exitCode=${result.exitCode ?? '?'}`,
    );
    return result;
  } catch (err) {
    console.error(`[flaxia-node] container: failed error=${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
};
