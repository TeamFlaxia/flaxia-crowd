import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/swarm-helper.js', import.meta.url)),
  alias: { '@flaxia/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
});

if (process.argv.includes('--test')) {
  await build({
    entryPoints: [fileURLToPath(new URL('./bridge.test.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../dist/bridge.test.js', import.meta.url)),
    alias: { '@flaxia/sdk': fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url)) },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
  });
}
