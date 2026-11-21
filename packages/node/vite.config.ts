import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // The bundle is served from a versioned /api/crowd/v<version>-0/ proxy path,
  // so wasm assets must resolve relative to the importing chunk.
  base: './',
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        worker: resolve(__dirname, 'src/worker/main.worker.ts'),
        'swarm-engine': resolve(__dirname, 'src/swarm/engine-entry.js'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
      }
    },
  },
  worker: {
    format: 'es',
    plugins: () => [],
  }
});
