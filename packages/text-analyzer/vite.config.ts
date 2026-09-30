import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // FLAXIA_API_KEY is intentionally NOT VITE_-prefixed. Vite only reads it in
  // the dev server process and injects it into proxied requests; it is never
  // bundled into browser JavaScript.
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.FLAXIA_API_KEY?.trim();

  return {
    server: {
      port: 5174,
      fs: {
        allow: ['..'],
      },
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      proxy: {
        '/crowd': {
          target: 'http://localhost:8787',
          changeOrigin: true,
          ws: true,
          ...(apiKey
            ? { headers: { Authorization: `Bearer ${apiKey}` } }
            : {}),
        },
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
