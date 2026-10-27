import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(readFileSync(resolve(workerRoot, 'package.json'), 'utf8'))

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
