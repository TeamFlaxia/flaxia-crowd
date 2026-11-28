# Releasing the Crowd packages (FriedFlaxia wasm)

Packages are **not** published to the npm registry. `@flaxia/node` and
`@flaxia/sdk` are distributed as tarballs attached to GitHub Releases, and
consumers install them straight from the release URL. `packages/text-analyzer`
and `packages/worker` stay private and are only used inside this monorepo.

The inference engine is **not** fetched from GitHub at runtime. It is compiled
from `friedflaxia/` to wasm, vendored into `packages/node/src/vendor/friedflaxia/`,
and emitted by the build as **separate assets** next to the JS glue
(`friedflaxia_wasm_bg.wasm` and the scalar fallback
`friedflaxia_wasm_bg.scalar.wasm`). They are packed into the release tarball and
finally copied into the Flaxia static build at `/crowd/v<version>-0/`
(same-origin, immutable). The browser fetches those `.wasm` files as separate
same-origin requests; they are deliberately **not** inlined as `data:` URLs
(`scripts/dist-wasm.test.mjs` guards this). A release therefore has a strict
order.

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
git tag node-v0.11.1
git push origin node-v0.11.1
```

Tag prefixes:

| Package        | Tag           | Release asset              |
| -------------- | ------------- | -------------------------- |
| `@flaxia/node` | `node-v0.11.1` | `flaxia-node-0.11.1.tgz`    |
| `@flaxia/sdk`  | `sdk-v0.9.1`  | `flaxia-sdk-0.9.1.tgz`     |

`release.yml` re-runs the vendoring verification (tag pushes do not trigger
`ci.yml`), installs with `npm ci`, builds the workspace, runs the package tests,
and then runs `npm pack` inside the tagged package directory. The resulting
`flaxia-<package>-<version>.tgz` is attached to the GitHub Release named after
the tag (created on first run). The workflow fails if the tag does not match the
version in `package.json`.

**Clobber policy:** on a re-run, `release.yml` uploads with
`gh release upload --clobber`. That replaces the *same-named asset of the same
tag* with a freshly built tarball; it never changes a different version or
release. This is only safe before that exact asset has been consumed: because
consumers pin exact versions and mirror the tarball in `flaxia/vendor/`, a
re-run that changes the bytes of an already-consumed asset would leave different
nodes on different code for one version. Once a tarball has been vendored or
installed anywhere, publish a new patch version and tag instead.

There is no registry step and no registry token is configured anywhere in the
workflow. Publishing is blocked on purpose: both packages define a
`prepublishOnly` script that exits with an error.

You can also run the workflow manually (`workflow_dispatch` with the `package`
input) to rebuild a tarball for the version currently in `package.json`.

## 3. Get the tarball to `flaxia`

Outside consumers can install the release asset directly:

```sh
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/node-v0.11.1/flaxia-node-0.11.1.tgz
npm install https://github.com/TeamFlaxia/flaxia-crowd/releases/download/sdk-v0.9.1/flaxia-sdk-0.9.1.tgz
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

- `https://flaxia.app/crowd/v0.11.1-0/index.js` returns JS (not 404).
- `https://flaxia.app/crowd/v0.11.1-0/friedflaxia_wasm_bg.wasm` and
  `friedflaxia_wasm_bg.scalar.wasm` are served as separate assets (not 404, and
  not `data:` URLs embedded in the JS).
- A consenting browser node registers and a `text-generation` / `decision`
  task completes; the network panel should show one `.wasm` fetch for the
  selected backend.
- If a device shows a numeric regression from SIMD, call
  `setFriedFlaxiaSimdEnabled(false)` from the vendored init helper to fall back
  to the scalar kernels without changing the model.

## Rollback

The `--clobber` upload described above is for rebuilding the asset of the
version currently being released. It is not a rollback mechanism: consumers pin
exact versions, so a rolled-back version must get a **new** version number and
tag. Restore the previous artifacts, bump the patch version, tag again, and
vendor the new tarballs plus `CROWD_NODE_VERSION` in the `flaxia` repository.
Never use a re-run to overwrite an already-consumed asset in place.
