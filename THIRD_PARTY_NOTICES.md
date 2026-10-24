# Third-party notices

This repository includes code from the projects below.

## Pooled (formerly SwarmLLM)

- Source: https://github.com/Nehanth/pooled
- Copyright (c) 2026 Nehanth Narendrula
- License: MIT (full text at `vendor/pooled/LICENSE`)
- Vendored code: `vendor/pooled/**` (engine pinned at commit
  `d6491f3f0771f62abf695954fab1c0f8e6363bdb`)
- Files that port or adapt Pooled code are listed in
  `vendor/pooled/VENDORED.md` and carry an attribution header.

## Native Swarm execution runtime

The optional native node Swarm helper bundles the same vendored Nehanth/pooled
engine described above; its MIT license and attribution also apply to this
bundle. See `vendor/pooled/LICENSE`, `AUTHORS`, and `VENDORED.md`.

Deno is installed separately and is not redistributed by this repository.
Native WebGPU is provided by Deno's Rust/wgpu runtime. Deno (MIT) and wgpu
(MIT/Apache-2.0) and their dependencies retain their respective licenses:
https://github.com/denoland/deno and https://github.com/gfx-rs/wgpu.
