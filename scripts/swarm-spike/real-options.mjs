import path from "node:path";
import { GENERATION_BASELINE } from "./generation-baseline.mjs";

export const PINNED_MODEL_URL = GENERATION_BASELINE.modelUrl;
export const CACHE_ROOT = "/tmp/flaxia-crowd";
export const DEFAULT_CACHE = path.join(CACHE_ROOT, "swarm-real.gguf");

export function resolveRealSpikeOptions(
  url = PINNED_MODEL_URL,
  cache = DEFAULT_CACHE,
) {
  if (url !== PINNED_MODEL_URL) {
    throw new Error("--url must match the pinned Hugging Face model URL");
  }

  const cachePath = path.resolve(cache);
  const relativeCachePath = path.relative(CACHE_ROOT, cachePath);
  if (
    !relativeCachePath ||
    relativeCachePath === ".." ||
    relativeCachePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCachePath)
  ) {
    throw new Error(`--cache must resolve inside ${CACHE_ROOT}`);
  }

  return { modelUrl: PINNED_MODEL_URL, cachePath };
}
