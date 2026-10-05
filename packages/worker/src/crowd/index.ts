import { Hono } from 'hono'
import type { Env } from '../index'
import type { SwarmNodeCapabilities, TaskRecord, WarmModelRange, WorkloadType } from '@flaxia/sdk'
import {
  isRoutableWorkload,
  defaultTimeoutFor,
  MAX_SWARM_NODES,
  NODE_SIGNAL_PROTOCOL,
  SUBSCRIBE_PROTOCOL,
  parseBearerSubprotocol,
} from '@flaxia/sdk'
import {
  createNodeToken,
  NODE_TOKEN_TTL_MS,
  verifyNodeToken,
  validateCallbackUrl,
  resolveTenantId,
  createSubscribeToken,
  verifySubscribeToken,
  SUBSCRIBE_TOKEN_TTL_MS,
  clampByteCapacity,
  MAX_WARM_MODEL_LAYERS,
} from '../security'

// Re-exported from @flaxia/sdk so hosts, worker and node share one definition.
export { isHeavyWorkload } from '@flaxia/sdk'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 3600000
/** Upper bound on `payload.allowedSites` entries. */
const MAX_ALLOWED_SITES = 16
/** Upper bound on a single site id. */
const MAX_SITE_ID_CHARS = 128

function originAllowed(origin: string, env: Env): boolean {
  const allowed = (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allowed.length === 0) return true
  return allowed.some(pattern => {
    if (pattern === origin) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2)
      return origin === suffix || origin.endsWith(`.${suffix}`)
    }
    return false
  })
}

/**
 * Resolve the caller's tenant from the bearer key.
 *
 * Legacy `API_KEYS` entries without an explicit tenant keep working: each key
 * becomes its own tenant, so nothing an existing client does changes except
 * that it can no longer read another tenant's tasks.
 */
export async function resolveCallerTenant(env: Env, authHeader: string | undefined): Promise<string | null> {
  return resolveTenantId(env.API_KEYS, authHeader)
}

export async function validateApiKey(env: Env, authHeader: string | undefined): Promise<boolean> {
  return (await resolveCallerTenant(env, authHeader)) !== null
}

function validatePayloadSize(env: Env, body: string): boolean {
  const maxStr = env.MAX_PAYLOAD_SIZE || '1048576'
  const max = parseInt(maxStr, 10) || 1048576
  return new TextEncoder().encode(body).byteLength <= max
}

/** Validate a node's advertised WebGPU capabilities; returns undefined when absent/invalid. */
export function parseSwarmCapabilities(value: unknown): SwarmNodeCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.webgpu !== 'boolean') return undefined
  const swarm: SwarmNodeCapabilities = { webgpu: record.webgpu }
  if (typeof record.gpuArchitecture === 'string') swarm.gpuArchitecture = record.gpuArchitecture
  // Self-reported: clamp it, otherwise `maxStorageBufferBindingSize: 1e300` would
  // be enough to win every swarm host election.
  const maxBuffer = clampByteCapacity(record.maxStorageBufferBindingSize)
  if (maxBuffer !== undefined) swarm.maxStorageBufferBindingSize = maxBuffer
  return swarm
}

/** Validate a node's warm model layer ranges; drops malformed entries. */
export function parseWarmModels(value: unknown): WarmModelRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges: WarmModelRange[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const layers = record.layers
    if (typeof record.modelId !== 'string' || !record.modelId) continue
    if (!Array.isArray(layers) || layers.length !== 2) continue
    const [start, end] = layers
    if (typeof start !== 'number' || typeof end !== 'number') continue
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0) continue
    // A range must be a real half-open span inside the accepted model depth:
    // `layers: [0, 1e9]` would otherwise mark a node warm for any model.
    if (end <= start || end > MAX_WARM_MODEL_LAYERS) continue
    ranges.push({ modelId: record.modelId, layers: [start, end] })
  }
  return ranges.length > 0 ? ranges : undefined
}

/**
 * Validate a `swarm-inference` payload at the API boundary.
 *
 * The scheduler tolerates unusable `swarm` options by falling back to defaults,
 * but silently reinterpreting a request means the client never learns its
 * options were dropped. Rejecting at submit time keeps a bad payload out of the
 * queue entirely. Returns an error message, or null when the payload is valid.
 */
export function validateSwarmPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object'
  }
  const body = payload as Record<string, unknown>

  if (body.maxNewTokens !== undefined && body.maxNewTokens !== null) {
    const maxNewTokens = body.maxNewTokens
    if (typeof maxNewTokens !== 'number' || !Number.isInteger(maxNewTokens) || maxNewTokens < 1) {
      return 'payload.maxNewTokens must be a positive integer'
    }
  }

  if (body.swarm === undefined || body.swarm === null) return null
  if (typeof body.swarm !== 'object' || Array.isArray(body.swarm)) {
    return 'payload.swarm must be an object'
  }
  const swarm = body.swarm as Record<string, unknown>

  const asCount = (key: 'minNodes' | 'maxNodes'): string | null => {
    const value = swarm[key]
    if (value === undefined || value === null) return null
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return `payload.swarm.${key} must be an integer >= 1`
    }
    if (value > MAX_SWARM_NODES) {
      return `payload.swarm.${key} must be <= ${MAX_SWARM_NODES}`
    }
    return null
  }
  const minError = asCount('minNodes')
  if (minError) return minError
  const maxError = asCount('maxNodes')
  if (maxError) return maxError

  const { minNodes, maxNodes } = swarm as { minNodes?: number; maxNodes?: number }
  if (minNodes !== undefined && maxNodes !== undefined && maxNodes < minNodes) {
    return 'payload.swarm.maxNodes must be >= payload.swarm.minNodes'
  }
  if (swarm.preferWarm !== undefined && swarm.preferWarm !== null && typeof swarm.preferWarm !== 'boolean') {
    return 'payload.swarm.preferWarm must be a boolean'
  }
  return null
}

/**
 * Read the optional `payload.allowedSites` allow-list. Returns an error message
 * when the value is malformed, or `undefined` sites when the task is open.
 */
export function parseAllowedSites(payload: unknown): { sites?: string[]; error?: string } {
  if (!payload || typeof payload !== 'object') return {}
  const value = (payload as Record<string, unknown>).allowedSites
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'payload.allowedSites must be a non-empty array of site ids' }
  }
  if (value.length > MAX_ALLOWED_SITES) {
    return { error: `payload.allowedSites must contain at most ${MAX_ALLOWED_SITES} entries` }
  }
  const sites: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry || entry.length > MAX_SITE_ID_CHARS) {
      return { error: 'payload.allowedSites entries must be non-empty site id strings' }
    }
    sites.push(entry)
  }
  return { sites }
}

const app = new Hono<{ Bindings: Env }>()

function getCoordinator(c: any) {
  const id = c.env.COORDINATOR.idFromName('global-coordinator')
  return c.env.COORDINATOR.get(id)
}

function checkOrigin(c: any): boolean {
  const origin = c.req.header('Origin')
  if (!origin) return true
  return originAllowed(origin, c.env)
}

/** Build the 101 response, echoing the negotiated subprotocol. */
function upgradeResponse(resp: Response, protocol: string): Response {
  const webSocket = (resp as Response & { webSocket?: WebSocket }).webSocket
  if (!webSocket) return resp
  return new Response(null, {
    status: 101,
    webSocket,
    headers: { 'Sec-WebSocket-Protocol': protocol },
  } as ResponseInit)
}

// --- Node registration & signaling ---

app.post('/nodes/register', async (c) => {
  let body: {
    siteId?: string
    nodeId?: string
    capabilities?: string[]
    deviceMemory?: number | null
    wasmMemoryBytes?: number
    swarm?: unknown
    warmModels?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // `siteId` remains accepted for compatibility, but it is an unauthenticated
  // claim. Coordinator scheduling deliberately does not use it for allowedSites.
  if (body?.siteId !== undefined && (typeof body.siteId !== 'string' || body.siteId.length > MAX_SITE_ID_CHARS)) {
    return c.json({ error: 'siteId must be a string of at most 128 characters' }, 400)
  }

  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((cap): cap is string => typeof cap === 'string')
    : []
  // Node identity is server-issued, always. A client-supplied `nodeId` is
  // ignored so it cannot register (and later connect) as another live node.
  const nodeId = crypto.randomUUID()

  if (!c.env.NODE_TOKEN_SECRET) {
    return c.json({ error: 'Node token secret is not configured' }, 503)
  }

  // A `null`/undefined deviceMemory means a mobile WebView or unknown device.
  const deviceMemory = typeof body.deviceMemory === 'number' ? body.deviceMemory : null
  // Self-reported and only used to order candidates, so clamp it to a sane
  // ceiling: a node claiming 1e300 bytes must not dominate host election.
  const wasmMemoryBytes = clampByteCapacity(body.wasmMemoryBytes)

  const swarm = parseSwarmCapabilities(body.swarm)
  const warmModels = parseWarmModels(body.warmModels)

  const exp = Date.now() + NODE_TOKEN_TTL_MS
  const token = await createNodeToken(c.env.NODE_TOKEN_SECRET, {
    siteId: body.siteId || '',
    nodeId,
    capabilities,
    deviceMemory,
    wasmMemoryBytes,
    swarm,
    warmModels,
    exp,
  })

  return c.json({ token, nodeId, expiresAt: exp, lowMemory: deviceMemory === null || deviceMemory < 4 })
})

app.get('/signal', async (c) => {
  const upgradeHeader = c.req.header('Upgrade')
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426)
  }
  if (!checkOrigin(c)) {
    return c.text('Origin not allowed', 403)
  }
  // The token must never travel in the URL: it leaks into logs and referrers.
  if (c.req.query('token') !== undefined) {
    return c.text('Token must be sent as the flaxia-node-v1 subprotocol, not a query parameter', 401)
  }

  const bearer = parseBearerSubprotocol(c.req.header('Sec-WebSocket-Protocol'), NODE_SIGNAL_PROTOCOL)
  if (!bearer) {
    return c.text(`Expected the ${NODE_SIGNAL_PROTOCOL} subprotocol with a bearer.<token> entry`, 401)
  }
  const payload = await verifyNodeToken(c.env.NODE_TOKEN_SECRET, bearer.token)
  if (!payload) {
    return c.text('Invalid or expired token', 401)
  }

  // The identity is taken from the verified token only. There is no
  // client-presented node id to disagree with, so a colliding id cannot
  // displace a live socket: only the holder of this node's token can claim it.
  const url = new URL(c.req.url)
  url.pathname = '/ws'
  url.searchParams.delete('token')
  url.searchParams.set('nodeId', payload.nodeId)
  url.searchParams.set('site', payload.siteId)
  url.searchParams.set('capabilities', payload.capabilities.join(','))
  url.searchParams.set('lowMemory', String(payload.deviceMemory === null || payload.deviceMemory === undefined || payload.deviceMemory < 4))
  if (typeof payload.wasmMemoryBytes === 'number') {
    url.searchParams.set('wasm', String(payload.wasmMemoryBytes))
  }
  if (payload.swarm?.webgpu) {
    url.searchParams.set('webgpu', 'true')
    if (payload.swarm.gpuArchitecture) url.searchParams.set('gpu', payload.swarm.gpuArchitecture)
    if (payload.swarm.maxStorageBufferBindingSize !== undefined) {
      url.searchParams.set('maxBuffer', String(payload.swarm.maxStorageBufferBindingSize))
    }
  }
  if (payload.warmModels?.length) {
    try {
      url.searchParams.set('warmModels', JSON.stringify(payload.warmModels))
    } catch {}
  }

  const stub = getCoordinator(c)
  const resp = await stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  }))
  return upgradeResponse(resp, NODE_SIGNAL_PROTOCOL)
})

app.get('/subscribe', async (c) => {
  const upgradeHeader = c.req.header('Upgrade')
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426)
  }
  if (!checkOrigin(c)) {
    return c.text('Origin not allowed', 403)
  }
  if (c.req.query('token') !== undefined) {
    return c.text('Token must be sent as the flaxia-subscribe-v1 subprotocol, not a query parameter', 401)
  }

  const taskId = c.req.query('taskId')
  if (!taskId) return c.text('taskId is required', 400)

  if (!c.env.SUBSCRIBE_TOKEN_SECRET) {
    return c.text('Subscribe token secret is not configured', 503)
  }
  const bearer = parseBearerSubprotocol(c.req.header('Sec-WebSocket-Protocol'), SUBSCRIBE_PROTOCOL)
  if (!bearer) {
    return c.text(`Expected the ${SUBSCRIBE_PROTOCOL} subprotocol with a bearer.<token> entry`, 401)
  }
  const claim = await verifySubscribeToken(c.env.SUBSCRIBE_TOKEN_SECRET, bearer.token)
  if (!claim) {
    return c.text('Invalid or expired subscribe token', 401)
  }
  // The token is bound to one task: a token for task A can never stream task B.
  if (claim.taskId !== taskId) {
    return c.text('Subscribe token does not match this task', 403)
  }

  const url = new URL(c.req.url)
  url.pathname = '/subscribe'
  url.searchParams.delete('token')
  url.searchParams.set('tenantId', claim.tenantId)
  const stub = getCoordinator(c)
  const resp = await stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  }))
  return upgradeResponse(resp, SUBSCRIBE_PROTOCOL)
})

// --- Task submission & polling ---

app.post('/tasks', async (c) => {
  const auth = c.req.header('Authorization')
  const tenantId = await resolveCallerTenant(c.env, auth)
  if (!tenantId) return c.json({ error: 'Unauthorized' }, 401)

  const rawBody = await c.req.text()
  if (!validatePayloadSize(c.env, rawBody)) return c.json({ error: 'Payload too large' }, 413)

  let body: { workload?: string; payload?: unknown; timeoutMs?: number; callbackUrl?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body.workload !== 'string' || !isRoutableWorkload(body.workload)) {
    return c.json({ error: 'Invalid workload type' }, 400)
  }
  if (!body.payload) return c.json({ error: 'payload is required' }, 400)

  if (body.workload === 'swarm-inference') {
    const swarmError = validateSwarmPayload(body.payload)
    if (swarmError) return c.json({ error: swarmError }, 400)
  }

  const { sites: allowedSites, error: sitesError } = parseAllowedSites(body.payload)
  if (sitesError) return c.json({ error: sitesError }, 400)

  let timeoutMs = body.timeoutMs
  if (timeoutMs === undefined || timeoutMs === null) {
    timeoutMs = defaultTimeoutFor(body.workload as WorkloadType)
  } else if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return c.json({ error: 'timeoutMs must be between 1000 and 3600000' }, 400)
  }

  let callbackUrl: string | undefined
  if (body.callbackUrl !== undefined) {
    if (typeof body.callbackUrl !== 'string') {
      return c.json({ error: 'callbackUrl must be a string' }, 400)
    }
    callbackUrl = validateCallbackUrl(body.callbackUrl) ?? undefined
    if (!callbackUrl) {
      return c.json({ error: 'callbackUrl is not allowed (HTTPS required, internal addresses blocked)' }, 400)
    }
    // Fail closed: without a signing secret the worker would have to deliver an
    // unsigned webhook, which the receiver cannot tell apart from a forgery.
    if (!c.env.WEBHOOK_SIGNING_SECRET) {
      return c.json({ error: 'Webhook signing is not configured (WEBHOOK_SIGNING_SECRET is unset)' }, 400)
    }
  }

  const taskId = crypto.randomUUID()
  const task: TaskRecord = {
    id: taskId,
    status: 'pending',
    workload: body.workload as WorkloadType,
    payload: body.payload as TaskRecord['payload'],
    createdAt: Date.now(),
    tenantId,
    allowedSites,
    retryCount: 0,
    timeoutMs,
    callbackUrl,
  }

  const stub = getCoordinator(c)
  const resp = await stub.fetch(new Request('http://internal/enqueue', {
    method: 'POST',
    body: JSON.stringify(task),
  }))
  if (!resp.ok) {
    const detail = await resp.json().catch(() => null) as { error?: string } | null
    const status = resp.status === 429 ? 429 : resp.status === 400 ? 400 : 502
    return c.json({ error: detail?.error ?? 'Task rejected' }, status)
  }

  const subscribeToken = c.env.SUBSCRIBE_TOKEN_SECRET
    ? await createSubscribeToken(c.env.SUBSCRIBE_TOKEN_SECRET, {
        tenantId,
        taskId,
        exp: Date.now() + SUBSCRIBE_TOKEN_TTL_MS,
      })
    : undefined

  return c.json({
    message: 'Task submitted',
    taskId,
    id: taskId,
    status: task.status,
    createdAt: task.createdAt,
    subscribeToken,
    subscribeTokenExpiresAt: subscribeToken ? Date.now() + SUBSCRIBE_TOKEN_TTL_MS : undefined,
  })
})

app.get('/tasks/:id', async (c) => {
  const auth = c.req.header('Authorization')
  const tenantId = await resolveCallerTenant(c.env, auth)
  if (!tenantId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const stub = getCoordinator(c)
  // The tenant is part of the storage key: another tenant's task is a 404, not
  // a redacted record.
  const resp = await stub.fetch(
    `http://internal/task/${encodeURIComponent(tenantId)}/${encodeURIComponent(id)}`,
  )
  if (resp.status === 404) return c.json({ error: 'Not found' }, 404)
  const task = await resp.json() as TaskRecord

  const subscribeToken = c.env.SUBSCRIBE_TOKEN_SECRET
    ? await createSubscribeToken(c.env.SUBSCRIBE_TOKEN_SECRET, {
        tenantId,
        taskId: id,
        exp: Date.now() + SUBSCRIBE_TOKEN_TTL_MS,
      })
    : undefined

  return c.json({
    ...task,
    subscribeToken,
    subscribeTokenExpiresAt: subscribeToken ? Date.now() + SUBSCRIBE_TOKEN_TTL_MS : undefined,
  })
})

export { app as crowdApp }