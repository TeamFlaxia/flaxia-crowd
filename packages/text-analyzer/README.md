# TextAnalyzer deployment configuration

The task API uses the same-origin `/crowd/*` server proxy. Configure the proxy's
`FLAXIA_API_KEY` on the server; never expose that key through a `VITE_` variable.

The opt-in volunteer node opens an authenticated signaling socket to the
coordinator. Set `VITE_FLAXIA_ORCHESTRATOR_URL` at build time to the coordinator
origin (`https://…`, with no path, credentials, query or fragment). A production
build without this value leaves node participation disabled. Development builds
default to `http://localhost:8787` for Wrangler.

The URL is not read from `localStorage`, because browser storage cannot
authorize a change of signaling server.
