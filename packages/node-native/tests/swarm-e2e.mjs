// Actual Rust signaling processes -> real workerd Coordinator -> Deno/wgpu
// Qwen35 slices with deterministic synthetic weights. No production model fetch.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { FlaxiaClient } from '../../sdk/dist/index.js';
import { GENERATION_BASELINE } from '../../../scripts/swarm-spike/generation-baseline.mjs';
import { prepareRealGeneration } from './prepare-real-generation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.FLAXIA_NATIVE_BINARY ??
  join(root, 'packages/node-native/target/release/flaxia-node-native');
const runtime = process.env.FLAXIA_DENO ??
  execFileSync('deno', ['eval', 'console.log(Deno.execPath())'], { encoding: 'utf8' }).trim();
const realModel = process.env.FLAXIA_REAL_MODEL;
const taskTimeout = realModel ? 600000 : 60000;
async function until(check, milliseconds = realModel ? 600000 : 45000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await check();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('native swarm test timed out');
}

test(
  realModel
    ? 'Qwen3.5-2B generation acceptance on two desktop nodes'
    : 'Synthetic Swarm transport smoke test (not real-model generation acceptance)',
  { timeout: realModel ? 900000 : 180000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flaxia-native-swarm-'));
    const children = [];
    let worker;
    try {
      const execution = realModel
        ? await prepareRealGeneration({ modelFile: realModel, runtime, directory })
        : {
          helper: join(root, 'packages/node-native/dist/swarm-fixture.js'),
          runtime,
        };
      if (realModel) {
        console.log(
          `Generation baseline: ${GENERATION_BASELINE.name} ${GENERATION_BASELINE.quantization} sha256=${GENERATION_BASELINE.sha256}`,
        );
      }
      const bundled = await build({
        entryPoints: [join(root, 'packages/worker/src/index.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        external: ['cloudflare:workers'],
      });
      worker = new Miniflare({
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: '2024-04-03',
        host: '127.0.0.1',
        port: 0,
        bindings: {
          API_KEYS: 'swarm-e2e-key:swarm-e2e',
          NODE_TOKEN_SECRET: 'native-swarm-e2e-secret',
          SUBSCRIBE_TOKEN_SECRET: 'native-swarm-sub-secret',
          CORS_ORIGINS: 'http://localhost',
          RATE_LIMIT_MAX: '1000',
          MAX_PAYLOAD_SIZE: '1048576',
        },
        durableObjects: { COORDINATOR: { className: 'Coordinator', useSQLite: true } },
      });
      const baseUrl = (await worker.ready).origin;
      // Scheduler keeps a third candidate available for a two-member session.
      for (let index = 0; index < 3; index++) {
        const config = join(directory, `node-${index}.toml`);
        await writeFile(
          config,
          `orchestrator_url = ${
            JSON.stringify(baseUrl)
          }\nsite_id = "native-swarm-e2e"\nparticipate = true\n[execution]\nmax_timeout_ms = ${taskTimeout}\n[execution.swarm]\nenabled = true\nallow_model_download = true\nruntime = ${
            JSON.stringify(execution.runtime)
          }\nhelper = ${JSON.stringify(execution.helper)}\n`,
        );
        const child = spawn(binary, ['--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
        const state = {
          child,
          logs: '',
          exited: new Promise((resolve, reject) => {
            child.once('exit', resolve);
            child.once('error', reject);
          }),
        };
        child.stdout.on('data', (chunk) => {
          state.logs = (state.logs + chunk).slice(-65536);
        });
        child.stderr.on('data', (chunk) => {
          state.logs = (state.logs + chunk).slice(-65536);
        });
        children.push(state);
        await until(() => {
          assert.equal(child.exitCode, null, state.logs);
          return state.logs.includes('node connected');
        });
      }
      const sdk = new FlaxiaClient({ baseUrl, apiKey: 'swarm-e2e-key' });
      for (let index = 0; index < (realModel ? 1 : 2); index++) {
        const submitted = await sdk.submit({
          workload: 'swarm-inference',
          payload: {
            model: GENERATION_BASELINE.model,
            prompt: realModel ? GENERATION_BASELINE.prompt : 'Ocean',
            maxNewTokens: realModel ? GENERATION_BASELINE.maxNewTokens : 4,
            swarm: { minNodes: 2, maxNodes: 2 },
          },
          timeoutMs: taskTimeout,
        });
        const task = await until(async () => {
          const task = await sdk.getTask(submitted.taskId);
          assert.notEqual(task.status, 'failed', JSON.stringify(task));
          return task.status === 'done' ? task : undefined;
        });
        assert.equal(task.result.nodes.length, 2, JSON.stringify(task));
        assert.equal(task.result.nodes[0].host, true);
        assert.equal(task.result.nodes[1].host, false);
        assert.equal(task.result.nodes[0].layers[0], 0);
        assert.equal(task.result.nodes[0].layers[1], task.result.nodes[1].layers[0]);
        if (realModel) {
          assert.ok(task.result.nodes[1].layers[1] > 4);
          assert.ok(
            task.result.tokens.length > 0 &&
              task.result.tokens.length <= GENERATION_BASELINE.maxNewTokens,
          );
          assert.match(task.result.output, /Paris/i);
          console.log(
            JSON.stringify({
              target: 'desktop',
              model: GENERATION_BASELINE.model,
              quantization: GENERATION_BASELINE.quantization,
              sha256: GENERATION_BASELINE.sha256,
              result: task.result,
            }),
          );
        } else {
          assert.equal(task.result.nodes[1].layers[1], 4);
          assert.equal(task.result.tokens.length, 4);
        }
        assert.equal(task.result.output, task.result.tokens.join(''));
        assert.ok(task.resultAttemptId);
      }
    } catch (error) {
      error.message += '\n' + children.map((state, i) => `node ${i}: ${state.logs}`).join('\n');
      throw error;
    } finally {
      for (const state of children) state.child.kill('SIGTERM');
      for (const state of children) {
        const stopped = await Promise.race([
          state.exited.then(() => true),
          delay(5000).then(() => false),
        ]);
        if (!stopped) state.child.kill('SIGKILL');
        await state.exited;
        assert.equal(stopped, true, state.logs);
        assert.equal(state.child.exitCode, 0, state.logs);
      }
      if (worker) await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
