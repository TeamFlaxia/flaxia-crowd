// Real workerd + Coordinator + SDK + native binary. No production deployment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { FlaxiaClient } from '../../sdk/dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/image-process.json', import.meta.url), 'utf8'));
const binary = process.env.FLAXIA_NATIVE_BINARY ?? join(root, 'packages/node-native/target/release/flaxia-node-native');

async function until(check, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for native worker integration');
}

async function stop(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(4000).then(() => false)]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
  assert.equal(stopped, true, 'native node must stop on SIGTERM');
  assert.equal(child.exitCode, 0);
}

test('fresh native node stays connected through idle heartbeats and executes SDK image tasks', { timeout: 150000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flaxia-native-worker-'));
  let worker;
  let node;
  let exited;
  let logs = '';
  try {
    const bundled = await build({
      entryPoints: [join(root, 'packages/worker/src/index.ts')],
      bundle: true, write: false, format: 'esm', platform: 'browser',
      external: ['cloudflare:workers'],
    });
    // Use Miniflare directly: Wrangler's interface enumeration is unnecessary
    // for this loopback-only test. The worker code still runs in real workerd.
    worker = new Miniflare({
      modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: '2024-04-03', host: '127.0.0.1', port: 0,
      bindings: {
        API_KEYS: 'native-e2e-test-key:native-e2e',
        NODE_TOKEN_SECRET: 'native-e2e-test-node-secret',
        SUBSCRIBE_TOKEN_SECRET: 'native-e2e-test-subscribe-secret',
        CORS_ORIGINS: 'http://localhost', RATE_LIMIT_MAX: '1000', MAX_PAYLOAD_SIZE: '1048576',
      },
      durableObjects: { COORDINATOR: { className: 'Coordinator', useSQLite: true } },
    });
    const baseUrl = (await worker.ready).origin;
    const config = join(directory, 'node.toml');
    await writeFile(config, `orchestrator_url = ${JSON.stringify(baseUrl)}\nsite_id = "native-e2e"\nparticipate = true\n[execution]\nimage_process = true\nmemory_limit_mb = 512\nmax_timeout_ms = 10000\n`);
    node = spawn(binary, ['--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise((resolve, reject) => { node.once('exit', resolve); node.once('error', reject); });
    const capture = (chunk) => { logs = (logs + chunk.toString()).slice(-65536); };
    node.stdout.on('data', capture); node.stderr.on('data', capture);
    await until(() => {
      assert.equal(node.exitCode, null, logs);
      return logs.includes('node connected');
    });
    // No tasks before the first heartbeat: exercises the reviewed alarm fix.
    // Two 35s waits cross the native client's 60s watchdog without blocking tools.
    await delay(35000);
    await delay(35000);
    assert.equal(node.exitCode, null, logs);
    assert.equal((logs.match(/node connected/g) ?? []).length, 1, logs);
    assert.equal(logs.includes('node disconnected'), false, logs);
    const sdk = new FlaxiaClient({ baseUrl, apiKey: 'native-e2e-test-key' });
    let nodeId;
    for (let index = 0; index < 2; index++) {
      const submitted = await sdk.submit({ workload: 'image-process', payload: fixture.payload, timeoutMs: 10000 });
      const task = await until(async () => {
        const task = await sdk.getTask(submitted.taskId);
        assert.notEqual(task.status, 'failed', JSON.stringify(task));
        return task.status === 'done' ? task : undefined;
      });
      assert.equal(task.resultNodeId, task.assignedNodeId);
      assert.ok(task.resultAttemptId);
      nodeId ??= task.resultNodeId;
      assert.equal(task.resultNodeId, nodeId, 'same native node should execute the next task');
      assert.equal(task.result.mimeType, fixture.expected.mimeType);
      assert.equal(task.result.originalSizeBytes, fixture.expected.originalSizeBytes);
      const bytes = Buffer.from(task.result.imageBase64, 'base64');
      assert.equal(bytes.length, task.result.resultSizeBytes);
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.equal(bytes.readUInt32BE(16), fixture.expected.width);
      assert.equal(bytes.readUInt32BE(20), fixture.expected.height);
    }
  } catch (error) {
    error.message += `\nNative node output:\n${logs}`;
    throw error;
  } finally {
    try { await stop(node, exited); } finally {
      if (worker) await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
