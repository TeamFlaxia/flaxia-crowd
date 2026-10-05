# Flaxia Crowd Worker

Crowd orchestration Worker and Durable Object coordinator.

## API overview

- `POST /crowd/tasks` submits a tenant-scoped workload.
- `GET /crowd/tasks/:id` reads only the caller's tenant tasks.
- `POST /crowd/nodes/register` returns a short-lived signed node token.
- `WS /crowd/signal` receives node connections; bearer tokens travel only in the WebSocket subprotocol.

Task payloads may include `allowedSites: string[]` to restrict execution to a site. **This restriction currently fails closed**: node registration is public and a submitted `siteId` is only a claim, not proof that the node controls that site. No node will satisfy the restriction until a cryptographically verified site proof is implemented. Do not rely on `siteId` claims for access control.

## Configuration

| Variable | Purpose |
|------|---------|
| `API_KEYS` | Comma-separated task API keys; `key:tenantId` scopes a key to a tenant. |
| `NODE_TOKEN_SECRET` | Signs node registration tokens (required). |
| `SUBSCRIBE_TOKEN_SECRET` | Signs task subscription tokens (required for subscribe). |
| `WEBHOOK_SIGNING_SECRET` | Dedicated webhook signatures (required when using `callbackUrl`). |

## Development

Install dependencies at repository root, then run the worker test suite and build via the root package scripts.

## Cloudflare Secrets

```bash
npx wrangler secret put API_KEYS
npx wrangler secret put NODE_TOKEN_SECRET
npx wrangler secret put SUBSCRIBE_TOKEN_SECRET
npx wrangler secret put WEBHOOK_SIGNING_SECRET
```

`API_KEYS` accepts comma-separated entries for staged rotation (`new,old`, then `new`). Never place secrets in browser-exposed `VITE_*` variables.
