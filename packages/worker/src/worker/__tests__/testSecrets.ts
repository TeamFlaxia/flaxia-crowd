/**
 * Secrets injected into the test bindings by `vitest.config.ts`.
 *
 * They exist so tests can exercise registration, signaling and webhook signing
 * against the real code paths. Production must supply its own values via
 * `wrangler secret put`; these strings must never be deployed.
 */
export const TEST_NODE_TOKEN_SECRET = 'test-node-token-secret';
export const TEST_WEBHOOK_SIGNING_SECRET = 'test-webhook-signing-secret';
export const TEST_SUBSCRIBE_TOKEN_SECRET = 'test-subscribe-token-secret';