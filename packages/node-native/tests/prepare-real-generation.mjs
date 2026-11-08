import { build } from 'esbuild';
import { chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  GENERATION_BASELINE,
  verifyGenerationModel,
} from '../../../scripts/swarm-spike/generation-baseline.mjs';

/** Trusted local test configuration only; the task cannot supply these paths. */
export async function prepareRealGeneration({ modelFile, runtime, directory }) {
  await verifyGenerationModel(modelFile);
  const helper = `${directory}/swarm-real.js`;
  await build({
    entryPoints: [fileURLToPath(new URL('./swarm-real.ts', import.meta.url))],
    outfile: helper,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    alias: { '@flaxia/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) },
    define: {
      FLAXIA_TEST_MODEL_FILE: JSON.stringify(modelFile),
      FLAXIA_TEST_MODEL_URL: JSON.stringify(GENERATION_BASELINE.modelUrl),
    },
  });
  const wrapper = `${directory}/real-model-runtime.sh`;
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  // Grant one immutable, hash-verified model file; keep the supervisor's other
  // Deno permissions, environment isolation and cancellation unchanged.
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = run ]; then\n shift\n exec ${quote(runtime)} run ${
      quote(`--allow-read=${modelFile}`)
    } "$@"\nfi\nexec ${quote(runtime)} "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  return { helper, runtime: wrapper };
}
