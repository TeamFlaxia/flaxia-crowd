import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Deployments are only allowed from a `crowd-v*` tag workflow. Outside GitHub
// Actions (e.g. a local checkout) these variables are unset, so `npm run
// deploy` cannot push a build by accident. `wrangler dev` does not use this
// script and is unaffected.
const refType = process.env.GITHUB_REF_TYPE
const refName = process.env.GITHUB_REF_NAME

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  refType !== 'tag' ||
  !/^crowd-v/.test(refName ?? '')
) {
  console.error(
    'deploy_requires_tag: deploy is only allowed from a crowd-v* tag ' +
    `(GITHUB_REF_TYPE=${refType ?? '<unset>'}, GITHUB_REF_NAME=${refName ?? '<unset>'})`,
  )
  process.exitCode = 1
} else {
  deploy()
}

function deploy() {
  const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const packageJson = JSON.parse(readFileSync(resolve(workerRoot, 'package.json'), 'utf8'))

  // The workflow performs the same check before running tests/deploy; keep it
  // here too so a mismatched tag cannot deploy even if the workflow is edited.
  const expectedTag = `crowd-v${packageJson.version}`
  if (refName !== expectedTag) {
    console.error(
      `deploy_version_mismatch: tag ${refName ?? '<unset>'} does not match ` +
      `packages/worker/package.json version ${packageJson.version} (expected ${expectedTag})`,
    )
    process.exitCode = 1
    return
  }

  function validSha(value) {
    const sha = value?.trim()
    return sha && /^[a-f0-9]{7,40}$/i.test(sha) ? sha : undefined
  }

  function resolveCommitSha() {
    const buildSha = validSha(process.env.WORKERS_CI_COMMIT_SHA) || validSha(process.env.GITHUB_SHA)
    try {
      const head = validSha(execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: workerRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }))
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: workerRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      // A modified checkout or a CI SHA for a different checkout cannot identify the deployed code.
      if (dirty || (buildSha && head && buildSha.toLowerCase() !== head.toLowerCase())) {
        return 'unknown'
      }
      return buildSha || head || 'unknown'
    } catch {
      // Builds may not include Git metadata; their supplied commit is the only available source.
      return buildSha || 'unknown'
    }
  }

  const args = [
    'wrangler',
    'deploy',
    ...process.argv.slice(2),
    '--var',
    'WORKER_VERSION:' + (packageJson.version || 'unknown'),
    '--var',
    'WORKER_COMMIT_SHA:' + resolveCommitSha(),
  ]
  const windows = process.platform === 'win32'
  const result = spawnSync(windows ? 'npx.cmd' : 'npx', args, {
    cwd: workerRoot,
    stdio: 'inherit',
    shell: windows,
  })

  if (result.error) {
    console.error('Failed to start Wrangler:', result.error.message)
    process.exitCode = 1
  } else {
    process.exitCode = result.status ?? 1
  }
}
