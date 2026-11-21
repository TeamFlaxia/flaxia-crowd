#!/usr/bin/env node
/**
 * Rebuild the vendored FriedFlaxia wasm from the Rust source of truth.
 *
 *   node scripts/sync-friedflaxia.mjs            # update the vendored files
 *   node scripts/sync-friedflaxia.mjs --check    # fail if they are stale
 *
 * Two wasm modules are shipped: the default `+simd128` build and a baseline
 * module for browsers without wasm SIMD. They share one wasm-bindgen glue;
 * `init.ts` picks the module with `WebAssembly.validate` before instantiating.
 *
 * The FriedFlaxia checkout defaults to the sibling `../friedflaxia` directory
 * and can be overridden with FRIEDFLAXIA_DIR. In CI the checkout is pinned to
 * the sourceCommit recorded in the manifest, so a Rust change cannot silently
 * leave an old wasm shipped to browsers.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = resolve(ROOT, 'packages/node/src/vendor/friedflaxia');
const MANIFEST_PATH = resolve(VENDOR_DIR, 'manifest.json');
const README_PATH = resolve(VENDOR_DIR, 'README.md');
const SIMD_WASM = 'friedflaxia_wasm_bg.wasm';
const SCALAR_WASM = 'friedflaxia_wasm_bg.scalar.wasm';
const GENERATED_FILES = [
  'friedflaxia_wasm.js',
  'friedflaxia_wasm.d.ts',
  SIMD_WASM,
  SCALAR_WASM,
  'friedflaxia_wasm_bg.wasm.d.ts',
];
const SHARED_MANIFEST = 'model-manifest.json';
const SCALAR_TARGET_DIR = resolve(ROOT, '.tmp-friedflaxia-target-scalar');

const checkOnly = process.argv.includes('--check');
const friedflaxiaDir = resolve(
  process.env.FRIEDFLAXIA_DIR ?? resolve(ROOT, '../friedflaxia'),
);
// The model pin / preprocess manifest has exactly one source of truth in the
// Rust crate; the browser copy is just a synced artifact.
const SHARED_MANIFEST_SOURCE = resolve(
  friedflaxiaDir,
  'crates/friedflaxia-core/model-manifest.json',
);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitHead(dir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`cannot read git HEAD in ${dir}: ${result.stderr?.trim() ?? 'unknown error'}`);
  }
  return result.stdout.trim();
}

function gitDescribe(dir) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : gitHead(dir);
}

function bindgenVersion(dir) {
  const result = spawnSync('wasm-bindgen', ['--version'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('wasm-bindgen is not installed or not on PATH');
  }
  return result.stdout.trim().replace(/^wasm-bindgen\s+/, '');
}

function build(outDir, { simd }) {
  if (!existsSync(resolve(friedflaxiaDir, 'scripts/build-wasm.sh'))) {
    throw new Error(
      `FriedFlaxia checkout not found at ${friedflaxiaDir}. Set FRIEDFLAXIA_DIR to its path.`,
    );
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    SOURCE_DATE_EPOCH: '0',
    FRIEDFLAXIA_WASM_SIMD: simd ? '1' : '0',
  };
  if (!simd) env.CARGO_TARGET_DIR = SCALAR_TARGET_DIR;
  const result = spawnSync('./scripts/build-wasm.sh', ['web', outDir], {
    cwd: friedflaxiaDir,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`wasm build failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}

/**
 * Vite always inlines assets in library mode, which would turn the 2 MB wasm
 * into base64 inside the glue chunk and force every browser to download both
 * variants. `?no-inline` is Vite's documented escape hatch, so patch the
 * generated glue after wasm-bindgen runs.
 */
function patchGlue(outDir) {
  const path = resolve(outDir, 'friedflaxia_wasm.js');
  const source = readFileSync(path, 'utf8');
  const marker = "new URL('friedflaxia_wasm_bg.wasm', import.meta.url)";
  if (!source.includes(marker)) {
    throw new Error('wasm-bindgen glue layout changed; update the no-inline patch');
  }
  writeFileSync(
    path,
    source.replace(marker, "new URL('friedflaxia_wasm_bg.wasm?no-inline', import.meta.url)"),
  );
}

function sourcePath(name, outDir, scalarDir) {
  if (name === SHARED_MANIFEST) return SHARED_MANIFEST_SOURCE;
  if (name === SCALAR_WASM) return resolve(scalarDir, SIMD_WASM);
  return resolve(outDir, name);
}

function syncedFiles() {
  return [...GENERATED_FILES, SHARED_MANIFEST];
}

function manifestFor(head, version, outDir, scalarDir) {
  return {
    sourceRepository: 'https://github.com/TeamFlaxia/friedflaxia',
    sourceCommit: head,
    wasmBindgenVersion: version,
    wasmSimd128: true,
    wasmScalarFallback: true,
    target: 'web',
    files: Object.fromEntries(
      syncedFiles().map((name) => [name, sha256(sourcePath(name, outDir, scalarDir))]),
    ),
  };
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function readmeFor(manifest) {
  return `# Vendored: FriedFlaxia wasm

Generated from the \`friedflaxia-wasm\` crate. Do not edit the generated files;
run \`node scripts/sync-friedflaxia.mjs\` from the flaxia-crowd root instead.

- Source: ${manifest.sourceRepository}
- Commit: ${manifest.sourceCommit}
- wasm-bindgen: ${manifest.wasmBindgenVersion}
- Target: \`${manifest.target}\` (\`./scripts/build-wasm.sh web <out>\`)
- wasm features: \`${manifest.wasmSimd128 ? 'simd128' : 'baseline'}\`${
    manifest.wasmScalarFallback ? ' + baseline fallback (`friedflaxia_wasm_bg.scalar.wasm`)' : ''
  }
- License: MIT

The source commit and SHA-256 of every generated file are recorded in
\`manifest.json\`. CI rebuilds from that exact commit and fails on drift.
Hand-written helpers (\`init.ts\`, \`types.ts\`) live in this directory too and
are preserved by the sync script. \`model-manifest.json\` is copied from the
Rust crate, which is its single source of truth.
`;
}

function check(outDir, scalarDir, head, version, manifest) {
  const problems = [];
  if (!manifest) {
    problems.push('manifest.json is missing');
  } else {
    if (manifest.sourceCommit !== head) {
      problems.push(`manifest sourceCommit ${manifest.sourceCommit} != checkout ${head}`);
    }
    if (manifest.wasmBindgenVersion !== version) {
      problems.push(
        `manifest wasm-bindgen ${manifest.wasmBindgenVersion} != installed ${version}`,
      );
    }
    if (!manifest.wasmScalarFallback) {
      problems.push('manifest does not record the baseline wasm fallback');
    }
  }
  if (sha256(resolve(outDir, SIMD_WASM)) === sha256(resolve(scalarDir, SIMD_WASM))) {
    problems.push('SIMD and baseline wasm builds are identical (scalar build did not run)');
  }
  for (const name of syncedFiles()) {
    const built = sourcePath(name, outDir, scalarDir);
    const vendored = resolve(VENDOR_DIR, name);
    if (!existsSync(vendored)) {
      problems.push(`missing vendored file: ${name}`);
      continue;
    }
    const builtHash = sha256(built);
    const vendoredHash = sha256(vendored);
    if (builtHash !== vendoredHash) {
      problems.push(`${name} is stale (vendored ${vendoredHash.slice(0, 12)}, built ${builtHash.slice(0, 12)})`);
    }
    if (manifest?.files?.[name] && manifest.files[name] !== vendoredHash) {
      problems.push(`${name} does not match manifest.json`);
    }
  }
  const expectedReadme = readmeFor(manifestFor(head, version, outDir, scalarDir));
  if (!existsSync(README_PATH) || readFileSync(README_PATH, 'utf8') !== expectedReadme) {
    problems.push('README.md is out of date');
  }
  if (problems.length > 0) {
    console.error('FriedFlaxia vendoring is stale:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('Run `node scripts/sync-friedflaxia.mjs` and commit the result.');
    process.exit(1);
  }
  console.log(`FriedFlaxia vendoring is current (${gitDescribe(friedflaxiaDir)}).`);
}

function main() {
  const tmpDir = resolve(ROOT, '.tmp-friedflaxia-wasm');
  const tmpScalarDir = resolve(ROOT, '.tmp-friedflaxia-wasm-scalar');
  build(tmpDir, { simd: true });
  patchGlue(tmpDir);
  build(tmpScalarDir, { simd: false });
  const head = gitHead(friedflaxiaDir);
  const version = bindgenVersion(friedflaxiaDir);
  const manifest = manifestFor(head, version, tmpDir, tmpScalarDir);

  if (checkOnly) {
    check(tmpDir, tmpScalarDir, head, version, readManifest());
    return;
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const name of syncedFiles()) {
    copyFileSync(sourcePath(name, tmpDir, tmpScalarDir), resolve(VENDOR_DIR, name));
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(README_PATH, readmeFor(manifest));
  console.log(`Vendored FriedFlaxia wasm from ${gitDescribe(friedflaxiaDir)} into ${VENDOR_DIR}`);
}

try {
  main();
} finally {
  for (const dir of ['.tmp-friedflaxia-wasm', '.tmp-friedflaxia-wasm-scalar']) {
    const tmpDir = resolve(ROOT, dir);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  }
}
