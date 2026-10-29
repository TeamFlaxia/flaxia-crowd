import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(workerRoot, '../..')

// The fake npx records arguments instead of deploying.
test('root deploy forwards flags and reports only a clean checkout SHA', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'crowd-deploy-test-'))
  const worker = join(root, 'packages/worker')
  const bin = join(root, 'bin')
  const output = join(tmpdir(), `crowd-deploy-args-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(join(worker, 'scripts'), { recursive: true })
    mkdirSync(bin)
    copyFileSync(join(repoRoot, 'package.json'), join(root, 'package.json'))
    copyFileSync(join(workerRoot, 'package.json'), join(worker, 'package.json'))
    copyFileSync(join(workerRoot, 'scripts/deploy.mjs'), join(worker, 'scripts/deploy.mjs'))
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DEPLOY_TEST_OUTPUT"\n', { mode: 0o755 })
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim()
    git('init', '-q')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
    const sha = git('rev-parse', 'HEAD')
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DEPLOY_TEST_OUTPUT: output }
    delete env.WORKERS_CI_COMMIT_SHA
    delete env.GITHUB_SHA
    const run = () => {
      execFileSync('npm', ['run', 'deploy', '--', '--dry-run', '--env', 'staging'], { cwd: root, env, stdio: 'pipe' })
      return readFileSync(output, 'utf8').trim().split('\n')
    }
    let args = run()
    assert.deepEqual(args.slice(0, 5), ['wrangler', 'deploy', '--dry-run', '--env', 'staging'])
    assert.ok(args.includes('WORKER_COMMIT_SHA:' + sha))
    writeFileSync(join(worker, 'changed.ts'), 'modified')
    args = run()
    assert.ok(args.includes('WORKER_COMMIT_SHA:unknown'))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(output, { force: true })
  }
})
