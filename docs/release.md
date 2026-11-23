# Releasing the Crowd packages (FriedFlaxia wasm)

Packages are **not** published to the npm registry. `@flaxia/node` and
`@flaxia/sdk` are distributed as tarballs attached to GitHub Releases, and
consumers install them straight from the release URL. `packages/text-analyzer`
and `packages/worker` stay private and are only used inside this monorepo.

The inference engine is **not** fetched from GitHub at runtime. It is compiled
from `friedflaxia/` to wasm, vendored into `packages/node/src/vendor/friedflaxia/`,
inlined into `@flaxia/node`'s bundle, packed into the release tarball, and
finally copied into the Flaxia static build at `/crowd/v<version>-0/` (same-origin,
immutable). A release therefore has a strict order.

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

## 2. Bump and tag

Bump `version` in the package you are releasing and in the matching entry of
`package-lock.json` (for example `packages/node/package.json`). Then push a tag
whose name is `<package>-v<version>`:

```sh
git tag node-v0.9.1
git push origin node-v0.9.1
```

Tag prefixes:

| Package        | Tag           | Release asset              |
| -------------- | ------------- | -------------------------- |
| `@flaxia/node` | `node-v0.9.1` | `flaxia-node-0.9.1.tgz`    |
| `@flaxia/sdk`  | `sdk-v0.7.1`  | `flaxia-sdk-0.7.1.tgz`     |

`release.yml` re-runs the vendoring verification (tag pushes do not trigger
`ci.yml`), installs with `npm ci`, builds the workspace, runs the package tests,
and then runs `npm pack` inside the tagged package directory. The resulting
`flaxia-<package>-<version>.tgz` is attached to the GitHub Release named after
the tag (created on first run, updated with `gh release upload --clobber` after
that). The workflow fails if the tag does not match the version in
`package.json`.

There is no registry step and no registry token is configured anywhere in the
workflow. Publishing is blocked on purpose: both packages define a
`prepublishOnly` script that exits with an error.

You can also run the workflow manually (`workflow_dispatch` with the `package`
input) to rebuild a tarball for the version currently in `package.json`.

## 3. Get the tarball to `flaxia`

Outside consumers can install the release asset directly:

```sh
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/node-v0.9.1/flaxia-node-0.9.1.tgz
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/sdk-v0.7.1/flaxia-sdk-0.7.1.tgz
```

`flaxia` does not install from the URL; it vendors the assets so CI needs no
network access to GitHub Releases:

In the `flaxia` repository:

- `vendor/flaxia-node-<version>.tgz` and `vendor/flaxia-sdk-<version>.tgz`
- `package.json` → `"@flaxia/node": "file:vendor/flaxia-node-<version>.tgz"`
  and `"@flaxia/sdk": "file:vendor/flaxia-sdk-<version>.tgz"`
- `package-lock.json` → refresh with `npm install` after changing the paths
- `shared/crowd-node.ts` → `CROWD_NODE_VERSION`

Then merge. `flaxia`'s build copies `node_modules/@flaxia/node/dist` into
`dist/crowd/v<version>-0/`, so `npm ci` needs no network access to the release
assets.

## 4. Verify production

- `https://flaxia.app/crowd/v0.9.1-0/index.js` returns JS (not 404).
- A consenting browser node registers and a `text-generation` / `decision`
  task completes (the wasm is inlined, so no extra `.wasm` request is expected).
- If a device shows a numeric regression from SIMD, call
  `setFriedFlaxiaSimdEnabled(false)` from the vendored init helper to fall back
  to the scalar kernels without changing the model.

## Rollback

GitHub Release assets can be replaced, but consumers pin exact versions, so a
rolled-back version must get a **new** version number and tag. Restore the
previous artifacts, bump the patch version, tag again, and vendor the new
tarballs plus `CROWD_NODE_VERSION`. Do not overwrite an
already-consumed asset in place.
