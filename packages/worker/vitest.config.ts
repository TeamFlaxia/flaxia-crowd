import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import {
  TEST_NODE_TOKEN_SECRET,
  TEST_SUBSCRIBE_TOKEN_SECRET,
  TEST_WEBHOOK_SIGNING_SECRET,
} from './src/worker/__tests__/testSecrets';

/**
 * Secrets are injected here instead of `wrangler.toml` so the test bindings can
 * never be deployed: production must provide them via `wrangler secret put`.
 * Tests that exercise registration, signaling and webhooks need them set.
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            NODE_TOKEN_SECRET: TEST_NODE_TOKEN_SECRET,
            WEBHOOK_SIGNING_SECRET: TEST_WEBHOOK_SIGNING_SECRET,
            SUBSCRIBE_TOKEN_SECRET: TEST_SUBSCRIBE_TOKEN_SECRET,
          },
        },
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});