// Explicit GPU acceptance run, separate from synthetic/unit CI checks.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CACHE } from './real-options.mjs';
import { GENERATION_BASELINE, verifyGenerationModel } from './generation-baseline.mjs';
const target = process.argv[2] ?? 'all';
if (!['all', 'web', 'desktop'].includes(target)) {
  throw new Error('target must be all, web or desktop');
}
const model = path.resolve(process.env.MODEL ?? DEFAULT_CACHE);
await verifyGenerationModel(model);
const root = fileURLToPath(new URL('../../', import.meta.url));
async function run(args, extraEnv) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  const status = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  if (status !== 0) throw new Error(`Qwen3.5-2B ${args.join(' ')} failed: ${status}`);
}
if (target === 'all' || target === 'web') {
  await run(['scripts/swarm-spike/check-real-worker.mjs'], {
    MODEL: model,
    CHAT_PROMPT: GENERATION_BASELINE.prompt,
    PROMPT: '',
    TOKENS: String(GENERATION_BASELINE.maxNewTokens),
  });
}
if (target === 'all' || target === 'desktop') {
  await run(['--test', 'packages/node-native/tests/swarm-e2e.mjs'], { FLAXIA_REAL_MODEL: model });
}
