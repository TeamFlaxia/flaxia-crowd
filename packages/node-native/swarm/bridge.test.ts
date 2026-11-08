import { NativeSwarmBridge } from './bridge';
import {
  buildSwarmChain,
  decodeSwarmEnvelope,
  signSwarmEnvelope,
  verifySwarmEnvelope,
} from '../../sdk/src/index';

declare const Deno: any;
const assert = (condition: unknown, message = 'assertion failed') => {
  if (!condition) throw new Error(message);
};
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('bridge test timed out');
};
const to64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const scope = { taskId: 'task', attemptId: 'attempt', sessionId: 'session' };
const members = [{ nodeId: 'host', capacity: 1 }, { nodeId: 'worker', capacity: 1 }];
const key = (value: number) =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(value))).replaceAll('+', '-').replaceAll(
    '/',
    '_',
  ).replaceAll('=', '');

Deno.test('native bridge authenticates frames, fences attempts and pauses/resumes tokens', async () => {
  const output: any[] = [];
  let disposed = 0;
  let embeds = 0;
  const bridge = new NativeSwarmBridge({
    plan: async () =>
      buildSwarmChain({
        sessionId: 'session',
        taskId: 'task',
        model: 'fixture',
        layers: 2,
        nodes: members,
      }).chain,
    load: async () => ({
      engine: {
        dim: 1,
        nc: 1,
        maxSeq: 32,
        reset() {},
        embedRun: async () => {
          embeds++;
          return new Float32Array([1]);
        },
        runHidden: async (hidden) => hidden,
        headFromHidden: async () => new Float32Array([0, 1]),
        setHidden() {},
        dispose() {
          disposed++;
        },
      },
      semantics: {
        packHidden: (hidden) => new Uint8Array(hidden.buffer),
        unpackHidden: (bytes) => new Float32Array(bytes.slice().buffer),
        argmax: () => 1,
        encodePrompt: () => [7],
        decodeTokens: (ids) => ids.join(''),
      },
    }),
  }, async (value) => {
    output.push(value);
  });
  const control = (message: object) =>
    bridge.accept({ kind: 'control', message: { ...scope, ...message } });
  await control({
    type: 'swarm-init',
    model: 'fixture',
    timeoutMs: 10000,
    members,
    prompt: 'hi',
    maxNewTokens: 1,
  });
  await wait(() => output.some((v) => v.message?.type === 'swarm-plan'));
  await control({
    type: 'swarm-slice',
    model: 'fixture',
    timeoutMs: 10000,
    index: 0,
    chainLength: 2,
    role: 'host',
    slice: { start: 0, end: 1, hasEmbed: true, hasHead: true },
    inboundKey: key(1),
    outboundKey: key(2),
  });
  await wait(() => output.some((v) => v.message?.type === 'swarm-ready'));
  assert(output.find((v) => v.message?.type === 'swarm-ready').message.peerReady === false);
  await control({ type: 'swarm-flow', paused: true });
  await control({ type: 'swarm-start' });
  await wait(() => output.some((v) => v.kind === 'frame'));
  const sent = output.find((v) => v.kind === 'frame');
  const decoded = decodeSwarmEnvelope(
    Uint8Array.from(atob(sent.data), (c) => c.charCodeAt(0)).buffer,
  )!;
  assert(await verifySwarmEnvelope(key(2), 'session', decoded.frame, decoded.mac!));
  // Wrong MAC and a valid MAC for a retired session may not advance the host.
  await bridge.accept({
    kind: 'frame',
    data: to64(await signSwarmEnvelope(key(9), 'session', decoded.frame)),
  });
  await bridge.accept({
    kind: 'frame',
    data: to64(await signSwarmEnvelope(key(1), 'old-session', decoded.frame)),
  });
  assert(!output.some((v) => v.message?.type === 'result'));
  await bridge.accept({
    kind: 'frame',
    data: to64(await signSwarmEnvelope(key(1), 'session', decoded.frame)),
  });
  await control({ type: 'swarm-flow', paused: false, attemptId: 'stale' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(!output.some((v) => v.message?.type === 'progress'));
  await control({ type: 'swarm-flow', paused: false });
  await wait(() => output.some((v) => v.kind === 'done'));
  const result = output.find((v) => v.message?.type === 'result').message;
  assert(
    result.taskId === 'task' && result.attemptId === 'attempt' && result.sessionId === 'session',
  );
  assert(result.payload.output === '1');
  assert(output.filter((v) => v.message?.type === 'progress').length === 1);
  assert(disposed === 1 && embeds === 1);
});
