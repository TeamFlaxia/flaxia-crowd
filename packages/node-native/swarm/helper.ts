// Deno supplies native wgpu (Rust), without Chromium or a DOM.
import { NativeSwarmBridge } from './bridge';
import { probeWebGpuDetailed } from '../../node/src/executor/webgpuProbe';

declare const Deno: any;
const encoder = new TextEncoder();
// Engine diagnostics must never corrupt the stdout protocol.
console.log = console.warn = console.error = () => {};
async function output(value: unknown) {
  const bytes = encoder.encode(JSON.stringify(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) offset += await Deno.stdout.write(bytes.subarray(offset));
  if ((value as any).kind === 'done') Deno.exit(0);
}
export async function runHelper(runtime: import('../../node/src/swarm/controller').SwarmRuntime) {
  if (Deno.args[0] === '--probe') {
    const report = await probeWebGpuDetailed();
    await output({ kind: 'probe', capabilities: report.capabilities });
    Deno.exit(report.capabilities.webgpu ? 0 : 1);
  }
  const bridge = new NativeSwarmBridge(runtime, output);
  // A complete IPC frame is bounded before parsing. Keep at most one partial line.
  const limit = 12 * 1024 * 1024;
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of Deno.stdin.readable) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > limit) Deno.exit(1);
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      await bridge.accept(JSON.parse(line));
    }
  }
  Deno.exit(1);
}
