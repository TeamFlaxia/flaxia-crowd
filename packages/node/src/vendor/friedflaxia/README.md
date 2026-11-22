# Vendored: FriedFlaxia wasm

Generated from the `friedflaxia-wasm` crate. Do not edit the generated files;
run `node scripts/sync-friedflaxia.mjs` from the flaxia-crowd root instead.

- Source: https://github.com/TeamFlaxia/friedflaxia
- Commit: dd85cb4692fc5d50b750d1e0ce917bd7a528ec78
- wasm-bindgen: 0.2.130
- Target: `web` (`./scripts/build-wasm.sh web <out>`)
- wasm features: `simd128` + baseline fallback (`friedflaxia_wasm_bg.scalar.wasm`)
- License: MIT

The source commit and SHA-256 of every generated file are recorded in
`manifest.json`. CI rebuilds from that exact commit and fails on drift.
Hand-written helpers (`init.ts`, `types.ts`) live in this directory too and
are preserved by the sync script. `model-manifest.json` is copied from the
Rust crate, which is its single source of truth.
