# Releasing the Crowd node (FriedFlaxia wasm)

The inference engine is **not** fetched from GitHub at runtime. It is compiled
from `friedflaxia/` to wasm, vendored into `packages/node/src/vendor/friedflaxia/`,
inlined into `@flaxia/node`'s bundle, published to npm, and finally served by
`flaxia.app` through the immutable `/api/crowd/v<version>-0/` proxy. A release
therefore has a strict order.

## 1. Merge with CI green

`ci.yml` has a `friedflaxia-vendoring` job that checks out the exact
`sourceCommit` from `vendor/friedflaxia/manifest.json`, rebuilds the wasm with
the pinned wasm-bindgen version, and fails on any drift. Do not merge with this
job red.

If a Rust change landed without regenerating the artifacts:

```sh
npm run sync:friedflaxia
npm run check:friedflaxia
node --test scripts/sync-friedflaxia.test.mjs scripts/friedflaxia-wasm-smoke.test.mjs
```

Commit the regenerated `.wasm`, glue, `.d.ts`, `manifest.json` and
`model-manifest.json` together.

## 2. Bump and publish `@flaxia/node`

Bump `version` in `packages/node/package.json` and in the `packages/node`
entry of `package-lock.json`. Then push a tag matching the version:

```sh
git tag node-v0.9.1
git push origin node-v0.9.1
```

`publish.yml` first re-runs the vendoring verification (tag pushes do not
trigger `ci.yml`), then runs `npm publish --provenance --access public`.

Verify with `npm view @flaxia/node version` before moving on.

## 3. Bump the app pin

In the `flaxia` repository update all three places to the published version:

- `packages/node/package.json` is in **this** repo (step 2).
- `shared/crowd-node.ts` → `CROWD_NODE_VERSION`
- `package.json` → `dependencies["@flaxia/node"]`
- `package-lock.json` → the root dependency and `node_modules/@flaxia/node`

After publishing, refresh the lockfile integrity if `npm ci` reports a
mismatch:

```sh
npm install --package-lock-only @flaxia/node@0.9.1
```

Then merge. `flaxia`'s CI runs `npm ci`, and `Deploy` runs only after CI
succeeds on `main`.

## 4. Verify production

- `https://flaxia.app/api/crowd/v0.9.1-0/index.js` returns JS (not 404).
- A consenting browser node registers and a `text-generation` / `decision`
  task completes (the wasm is inlined, so no extra `.wasm` request is expected).
- If a device shows a numeric regression from SIMD, call
  `setFriedFlaxiaSimdEnabled(false)` from the vendored init helper to fall back
  to the scalar kernels without changing the model.

## Rollback

npm versions are immutable. To roll back, publish a new patch version with the
previous artifacts restored and bump `CROWD_NODE_VERSION` again. Never edit an
already-published version in place.
