import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'FlaxiaSDK',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: [],
    },
  },
  // Emit the module declaration files that index.ts re-exports. The rollup
  // declaration path leaves unresolved barrel exports with the current TS6 toolchain.
  plugins: [dts()],
});
