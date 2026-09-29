import { Hono } from 'hono'
import type { Env } from '../index'
import type { SwarmNodeCapabilities, TaskRecord, WarmModelRange, WorkloadType } from '@flaxia/sdk'
import { isRoutableWorkload } from '@flaxia/sdk'
import {
  createNodeToken,
  NODE_TOKEN_TTL_MS,
  verifyNodeToken,
  validateCallbackUrl,
  safeEqual,
} from '../security'
import { DEFAULT_TIMEOUT_MS } from '../worker/Coordinator'

// Re-exported from @flaxia/sdk so hosts, worker and node share one definition.
export { isHeavyWorkload } from '@flaxia/sdk'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 3600000

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

export async function validateApiKey(env: Env, authHeader: string | undefined): Promise<boolean> {
  if (!authHeader) return false
  const [scheme, token] = authHeader.split(' ')
  if (scheme !== 'Bearer' || !token) return false
  const staticKeys = (env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean)
  return staticKeys.some(key => safeEqual(key, token))
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
  if (typeof record.maxStorageBufferBindingSize === 'number' && Number.isFinite(record.maxStorageBufferBindingSize)) {
    swarm.maxStorageBufferBindingSize = record.maxStorageBufferBindingSize
  }
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
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue
    ranges.push({ modelId: record.modelId, layers: [start, end] })
  }
  return ranges.length > 0 ? ranges : undefined
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

// --- Node registration & signaling ---

app.post('/nodes/register', async (c) => {
  let body: {
    siteId?: string
    nodeId?: string
    capabilities?: string[]
    deviceMemory?: number | null
    swarm?: unknown
    warmModels?: unknown
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (!body || typeof body.siteId !== 'string' || !body.siteId) {
    return c.json({ error: 'siteId is required' }, 400)
  }

  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((cap): cap is string => typeof cap === 'string')
    : []
  const nodeId = typeof body.nodeId === 'string' && body.nodeId
    ? body.nodeId
    : crypto.randomUUID()

  if (!c.env.NODE_TOKEN_SECRET) {
    return c.json({ error: 'Node token secret is not configured' }, 503)
  }

  // A `null`/undefined deviceMemory means a mobile WebView or unknown device.
  const deviceMemory = typeof body.deviceMemory === 'number' ? body.deviceMemory : null

  const swarm = parseSwarmCapabilities(body.swarm)
  const warmModels = parseWarmModels(body.warmModels)

  const exp = Date.now() + NODE_TOKEN_TTL_MS
  const token = await createNodeToken(c.env.NODE_TOKEN_SECRET, {
    siteId: body.siteId,
    nodeId,
    capabilities,
    deviceMemory,
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

  const token = c.req.query('token')
  const payload = await verifyNodeToken(c.env.NODE_TOKEN_SECRET, token)
  if (!payload) {
    return c.text('Invalid or expired token', 401)
  }

  const url = new URL(c.req.url)
  url.pathname = '/ws'
  url.searchParams.set('nodeId', payload.nodeId)
  url.searchParams.set('capabilities', payload.capabilities.join(','))
  url.searchParams.set('lowMemory', String(payload.deviceMemory === null || payload.deviceMemory === undefined || payload.deviceMemory < 4))
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
  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  }))
})

app.get('/subscribe', async (c) => {
  const upgradeHeader = c.req.header('Upgrade')
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426)
  }
  if (!checkOrigin(c)) {
    return c.text('Origin not allowed', 403)
  }

  const taskId = c.req.query('taskId')
  if (!taskId) return c.text('taskId is required', 400)

  const url = new URL(c.req.url)
  url.pathname = '/subscribe'
  const stub = getCoordinator(c)
  return stub.fetch(new Request(url.toString(), {
    headers: c.req.raw.headers,
    signal: c.req.raw.signal,
  }))
})

// --- Task submission & polling ---

app.post('/tasks', async (c) => {
  const auth = c.req.header('Authorization')
  if (!await validateApiKey(c.env, auth)) return c.json({ error: 'Unauthorized' }, 401)

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

  let timeoutMs = body.timeoutMs
  if (timeoutMs === undefined || timeoutMs === null) {
    timeoutMs = DEFAULT_TIMEOUT_MS
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
    callbackUrl = validateCallbackUrl(body.callbackUrl)
    if (!callbackUrl) {
      return c.json({ error: 'callbackUrl is not allowed (HTTPS required, internal addresses blocked)' }, 400)
    }
  }

  const taskId = crypto.randomUUID()
  const task: TaskRecord = {
    id: taskId,
    status: 'pending',
    workload: body.workload as WorkloadType,
    payload: body.payload as any,
    createdAt: Date.now(),
    retryCount: 0,
    timeoutMs,
    callbackUrl,
  }

  const stub = getCoordinator(c)
  await stub.fetch(new Request('http://internal/enqueue', {
    method: 'POST',
    body: JSON.stringify(task),
  }))

  return c.json({ message: 'Task submitted', taskId, id: taskId, status: task.status, createdAt: task.createdAt })
})

app.get('/tasks/:id', async (c) => {
  const auth = c.req.header('Authorization')
  if (!await validateApiKey(c.env, auth)) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const stub = getCoordinator(c)
  const resp = await stub.fetch(`http://internal/task/${id}`)
  if (resp.status === 404) return c.json({ error: 'Not found' }, 404)
  const task = await resp.json()
  return c.json(task)
})

export { app as crowdApp }
