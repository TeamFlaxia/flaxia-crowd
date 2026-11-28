import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(workerRoot, '../..')
const skipWindows = { skip: process.platform === 'win32' }
const workerPackage = JSON.parse(readFileSync(join(workerRoot, 'package.json'), 'utf8'))
const workerLock = JSON.parse(readFileSync(join(workerRoot, 'package-lock.json'), 'utf8'))
const matchingTag = `crowd-v${workerPackage.version}`
const mismatchedTag = 'crowd-v0.0.0'

// Copy deploy.mjs into an isolated fixture: the fake `npx` on PATH is the only
// thing that can answer a deploy call, and the fixture git repo supplies a SHA.
function withFixture(run, refs = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crowd-deploy-test-'))
  const worker = join(root, 'packages/worker')
  const bin = join(root, 'bin')
  const output = join(tmpdir(), `crowd-deploy-args-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
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
    delete env.GITHUB_REF_TYPE
    delete env.GITHUB_REF_NAME
    if (refs.actions !== false) env.GITHUB_ACTIONS = 'true'
    else delete env.GITHUB_ACTIONS
    if (refs.refType !== undefined) env.GITHUB_REF_TYPE = refs.refType
    if (refs.refName !== undefined) env.GITHUB_REF_NAME = refs.refName
    return run({ root, worker, output, env, sha })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(output, { force: true })
  }
}

const invokeDeploy = (root, env) => execFileSync(
  'npm', ['run', 'deploy', '--', '--dry-run', '--env', 'staging'],
  { cwd: root, env, stdio: 'pipe' },
)

function assertDeployRejected({ root, env, output }, reason = /deploy_requires_tag/) {
  let error
  try {
    invokeDeploy(root, env)
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'deploy should have failed')
  assert.equal(error.status, 1)
  assert.match(String(error.stderr ?? ''), reason)
  assert.equal(existsSync(output), false, 'wrangler must not be invoked')
}

test('root deploy forwards flags and reports only a clean checkout SHA', skipWindows, () => {
  withFixture(({ root, worker, output, env, sha }) => {
    const run = () => {
      invokeDeploy(root, env)
      return readFileSync(output, 'utf8').trim().split('\n')
    }
    let args = run()
    assert.deepEqual(args.slice(0, 5), ['wrangler', 'deploy', '--dry-run', '--env', 'staging'])
    assert.ok(args.includes('WORKER_COMMIT_SHA:' + sha))
    writeFileSync(join(worker, 'changed.ts'), 'modified')
    args = run()
    assert.ok(args.includes('WORKER_COMMIT_SHA:unknown'))
  }, { refType: 'tag', refName: matchingTag })
})

test('deploy without tag ref information fails before calling wrangler', skipWindows, () => {
  withFixture(assertDeployRejected)
})

test('deploy rejects a crowd tag whose version does not match package.json', skipWindows, () => {
  withFixture(
    (fixture) => assertDeployRejected(fixture, /deploy_version_mismatch/),
    { refType: 'tag', refName: mismatchedTag },
  )
})

test('worker package-lock version matches package.json', () => {
  assert.equal(workerLock.version, workerPackage.version)
  assert.equal(workerLock.packages[''].version, workerPackage.version)
})

for (const [label, refs] of [
  ['main branch push', { refType: 'branch', refName: 'main' }],
  ['branch named like a crowd tag', { refType: 'branch', refName: matchingTag }],
  ['tag named main', { refType: 'tag', refName: 'main' }],
  ['node sdk tag', { refType: 'tag', refName: 'node-v0.0.0' }],
  ['tag name without ref type', { refName: matchingTag }],
  ['forged tag env outside GitHub Actions', {
    actions: false,
    refType: 'tag',
    refName: matchingTag,
  }],
]) {
  test(`deploy rejects ${label}`, skipWindows, () => {
    withFixture(assertDeployRejected, refs)
  })
}
