#!/usr/bin/env node
// Register an API key in D1 without ever putting the raw key in argv, logs or
// this repository. Only its SHA-256 digest is stored, matching security.ts's
// `resolveTenantIdFromDb` lookup exactly.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DB_NAME = 'flaxia-crowd-keys'
// Restrict tenants to characters that are safe in SQL and in log output.
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fail(message) {
  console.error(`add-api-key: ${message}`)
  process.exit(1)
}

function printUsage() {
  console.log(`Usage:
  API_KEY=<key> node scripts/add-api-key.mjs [--tenant <tenant-id>] [--execute]
  printf '%s' "$API_KEY" | node scripts/add-api-key.mjs --tenant tenant-a --execute

The API key is read from the API_KEY environment variable or from stdin.
It must NEVER be passed as a command-line argument (argv is world-readable).
Without --tenant the tenant is key-<first 16 hex digits of the hash>, the same
stable id that legacy API_KEYS entries get in security.ts.
By default the INSERT statement is printed; --execute runs it on remote D1.`)
}

function parseArgs(argv) {
  let tenant
  let execute = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else if (arg === '--execute') {
      execute = true
    } else if (arg === '--tenant') {
      tenant = argv[++i]
      if (!tenant) fail('--tenant requires a non-empty value')
    } else if (arg.startsWith('--tenant=')) {
      tenant = arg.slice('--tenant='.length)
      if (!tenant) fail('--tenant requires a non-empty value')
    } else {
      fail(`unexpected argument ${JSON.stringify(arg)}; the key must come from API_KEY or stdin, never argv`)
    }
  }
  return { tenant, execute }
}

async function readKey() {
  if (process.env.API_KEY !== undefined) {
    if (!process.env.API_KEY) fail('API_KEY is empty')
    return process.env.API_KEY
  }
  if (process.stdin.isTTY) {
    fail('no API_KEY set and stdin is a terminal; set API_KEY or pipe the key')
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  // Drop one trailing newline from `echo`/heredoc; keep every other byte so the
  // digest matches the bearer token the Worker receives verbatim.
  const key = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  if (!key) fail('no API key received on stdin')
  return key
}

async function main() {
  const { tenant: requestedTenant, execute } = parseArgs(process.argv.slice(2))
  const key = await readKey()
  if (key !== key.trim()) fail('API key has leading/trailing whitespace; pass the exact token bytes')

  // security.ts hashes new TextEncoder().encode(token) with WebCrypto SHA-256
  // and lowercases each byte to hex. Node's UTF-8 digest produces the same 64
  // lowercase hex characters.
  const hash = createHash('sha256').update(key, 'utf8').digest('hex')
  const tenant = requestedTenant ?? `key-${hash.slice(0, 16)}`
  if (!TENANT_RE.test(tenant)) fail(`invalid tenant id: expected ${TENANT_RE}`)

  // Escape quotes even though TENANT_RE already excludes them.
  const sql = `INSERT INTO api_keys (key_hash, tenant_id) VALUES ('${hash}', '${tenant.replace(/'/g, "''")}');`
  console.log('-- key_hash is the lowercase SHA-256 hex digest; the raw key is never printed')
  console.log(sql)

  if (execute) {
    const workerRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    // execFileSync passes one argument per token (no shell), so neither the
    // statement nor the tenant id can be interpreted as shell syntax.
    execFileSync(npx, ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', sql], {
      cwd: workerRoot,
      stdio: 'inherit',
    })
    console.log(`add-api-key: registered hash ${hash} for tenant ${tenant} in ${DB_NAME}`)
  }
}

main().catch((error) => {
  // Log only the error message: never echo the key, which is not part of it.
  fail(error instanceof Error ? error.message : String(error))
})
