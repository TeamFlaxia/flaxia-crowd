import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildSynthGGUF } from '../../../vendor/pooled/synth/synth.mjs';
const url = (relative) => fileURLToPath(new URL(relative, import.meta.url));
await mkdir(url('../dist'), { recursive: true });
await writeFile(url('../dist/synth.gguf'), buildSynthGGUF({ layers: 4, dim: 64 }).bytes);
await build({
  entryPoints: [url('./swarm-fixture.ts')],
  outfile: url('../dist/swarm-fixture.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  loader: { '.gguf': 'binary' },
  alias: { '@flaxia/sdk': url('../../sdk/src/index.ts') },
});

await build({
  entryPoints: [url('./head-bindings.test.ts')],
  outfile: url('../dist/head-bindings.test.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  loader: { '.gguf': 'binary' },
});
