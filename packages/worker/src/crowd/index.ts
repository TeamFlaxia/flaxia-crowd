import { Hono } from 'hono'
import { originMatchesPattern } from '../origin'
import type { Env } from '../index'
import type { TaskRecord, WarmModelRange, WorkloadType } from '@flaxia/sdk'
import { isTaskPriority, TASK_PRIORITY_DEFAULT } from '../worker/queue-scheduler'
import {
  isRoutableWorkload,
  defaultTimeoutFor,
  MAX_CC_EXTRACT_RECORDS,
  MAX_CC_EXTRACT_RECORD_BYTES,
  MAX_CC_EXTRACT_TOTAL_BYTES,
  MAX_CC_EXTRACT_TIMEOUT_MS,
  MAX_CC_EXTRACT_URL_CHARS,
  MAX_CC_EXTRACT_FETCH_URL_CHARS,
  MAX_EMBED_GEMMA_TEXTS,
  MAX_EMBED_GEMMA_TOTAL_CHARS,
  MAX_EMBED_GEMMA_TEXT_CHARS,
  isEmbedGemmaDimensions,
  isTheiaInferencePayload,
  isTheiaExpertCapability,
  MAX_THEIA_CANVAS_CHARS,
  CC_CRAWL_PATTERN,
  ccWarcPathMatchesCrawl,
  NODE_SIGNAL_PROTOCOL,
  SUBSCRIBE_PROTOCOL,
  parseBearerSubprotocol,
  isSafePublicUrl,
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
  MAX_NODE_EXPERT_CAPABILITIES,
} from '../security'

// Re-exported from @flaxia/sdk so hosts, worker and node share one definition.
export { isHeavyWorkload } from '@flaxia/sdk'

const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 3600000
/** Measured WASM memory below this is not enough for a heavy workload. */
const LOW_MEMORY_WASM_BYTES = 2 * 1024 ** 3
/** Physical RAM (GiB) below this is not enough for a heavy workload. */
const LOW_MEMORY_DEVICE_GIB = 4

/**
 * Decide whether a node is too memory-constrained for heavy workloads.
 *
 * Browser nodes report a measured `wasmMemoryBytes` probe; that wins when
 * present. Native (non-WASM) nodes only report physical RAM as
 * `deviceMemory` in GiB and never send `wasmMemoryBytes` — treating a
 * missing probe as low-memory would exclude every native node from every
 * heavy workload, so fall back to the deviceMemory signal. A node reporting
 * neither (e.g. a mobile WebView) stays low-memory, as before.
 */
function isLowMemoryNode(
  wasmMemoryBytes: number | undefined,
  deviceMemory: number | null | undefined,
): boolean {
  if (typeof wasmMemoryBytes === 'number') return wasmMemoryBytes < LOW_MEMORY_WASM_BYTES
  return deviceMemory == null || deviceMemory < LOW_MEMORY_DEVICE_GIB
}
/** Upper bound on a single site id (registration still accepts siteId). */
const MAX_SITE_ID_CHARS = 128
/** Upper bound on the number of capabilities a node may advertise. */
const MAX_NODE_CAPABILITIES = 32
/** Upper bound on a single capability string. */
const MAX_CAPABILITY_CHARS = 64
/** Upper bound on a warm-model repository id. */
const MAX_WARM_MODEL_ID_CHARS = 128

function originAllowed(origin: string, env: Env): boolean {
  const allowed = (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allowed.length === 0) return true
  return allowed.some(pattern => originMatchesPattern(origin, pattern))
}

/**
 * Media URLs are fetched by volunteer nodes, so an `https://` prefix alone is
 * not enough: localhost/private hosts, credentials, odd ports and trailing-dot
 * name tricks must be rejected here before a task occupies a volunteer slot.
 * Uses the same SDK helper as the callback and node egress checks.
 */
function isSafeMediaUrl(value: unknown): boolean {
  return typeof value === 'string' && isSafePublicUrl(value) !== null
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

/** Validate a node's warm model layer ranges; drops malformed entries. */
export function parseWarmModels(value: unknown): WarmModelRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges: WarmModelRange[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const layers = record.layers
    if (typeof record.modelId !== 'string' || !record.modelId) continue
    if (record.modelId.length > MAX_WARM_MODEL_ID_CHARS) continue
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
 * Validate `ai-inference` ondeviceOnly at the API boundary. Only a boolean
 * (or absent) is accepted; anything else would silently reinterpret the
 * Light Inference gate and is rejected with 400.
 */
export function validateAiInferencePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object'
  }
  const body = payload as Record<string, unknown>
  if (body.engine !== undefined && body.engine !== 'transformers' && body.engine !== 'friedflaxia') {
    return 'payload.engine must be transformers or friedflaxia'
  }
  if (body.engine === 'friedflaxia' && body.task !== 'text-generation' && body.task !== 'decision') {
    return 'payload.engine=friedflaxia currently supports text-generation or decision only'
  }
  const options = body.options
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object' || Array.isArray(options)) {
      return 'payload.options must be an object'
    }
    const rec = options as Record<string, unknown>
    if (rec.ondeviceOnly !== undefined && rec.ondeviceOnly !== null && typeof rec.ondeviceOnly !== 'boolean') {
      return 'payload.options.ondeviceOnly must be a boolean'
    }
  }
  // Decision-mode (d1-omni): mirror the node's decision limits at the API
  // boundary so malformed questions/media never occupy a volunteer slot.
  // Limits mirror packages/node/src/workloads/decision.ts.
  if (body.decision !== undefined) {
    if (typeof body.model !== 'string' || body.model !== 'LiquidAI/d1-omni-600M') {
      return 'payload.model must be LiquidAI/d1-omni-600M when payload.decision is set'
    }
    if (!body.decision || typeof body.decision !== 'object' || Array.isArray(body.decision)) {
      return 'payload.decision must be an object'
    }
    const decision = body.decision as Record<string, unknown>
    const questions = decision.questions
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
      return 'payload.decision.questions must be an object'
    }
    const names = Object.keys(questions as Record<string, unknown>)
    if (names.length === 0 || names.length > 8) {
      return 'payload.decision.questions must hold 1..8 entries'
    }
    for (const q of Object.values(questions as Record<string, unknown>)) {
      if (!q || typeof q !== 'object' || Array.isArray(q)) {
        return 'payload.decision.questions entries must be objects'
      }
      const rec = q as Record<string, unknown>
      if (rec.type !== 'noul' && rec.type !== 'choice' && rec.type !== 'score') {
        return 'payload.decision.questions entries must have type noul, choice, or score'
      }
      if (typeof rec.instructions !== 'string' || !rec.instructions) {
        return 'payload.decision.questions entries need instructions'
      }
      if (rec.type === 'choice' && (!rec.criteria || typeof rec.criteria !== 'object' || Array.isArray(rec.criteria))) {
        return 'payload.decision.questions choice entries need criteria object'
      }
      if (rec.type === 'score' && (!Array.isArray(rec.criteria) || rec.criteria.length < 2 || rec.criteria.length > 10)) {
        return 'payload.decision.questions score entries need 2..10 levels'
      }
    }
    const state = decision.state
    if (state !== undefined && state !== null && typeof state !== 'string') {
      return 'payload.decision.state must be a string or null'
    }
    if (typeof state === 'string' && state.length > 20000) {
      return 'payload.decision.state exceeds 20000 characters'
    }
    const imageUrls = decision.imageUrls ?? []
    if (decision.imageUrls !== undefined && !Array.isArray(imageUrls)) {
      return 'payload.decision.imageUrls must be an array'
    }
    if (Array.isArray(imageUrls) && imageUrls.length > 8) {
      return 'payload.decision.imageUrls must hold 0..8 URLs'
    }
    for (const url of (Array.isArray(imageUrls) ? imageUrls : [])) {
      if (!isSafeMediaUrl(url)) {
        return 'payload.decision.imageUrls must be public https:// URLs'
      }
    }
    const audioUrl = decision.audioUrl
    if (audioUrl !== undefined && !isSafeMediaUrl(audioUrl)) {
      return 'payload.decision.audioUrl must be a public https:// URL'
    }
    if (Array.isArray(imageUrls) && imageUrls.length > 0 && audioUrl !== undefined) {
      return 'payload.decision: pass images or audio in one call, not both'
    }
    if ((state === null || state === '' || state === undefined) && (!Array.isArray(imageUrls) || imageUrls.length === 0) && audioUrl === undefined) {
      return 'payload.decision: null state needs at least one image or an audio clip'
    }
  }
  return null
}

/**
 * Validate a `vector-embed` payload at the API boundary. Mirrors the node's
 * multimodal limits (packages/node/src/workloads/vector-embed.ts) so malformed
 * media references never occupy a volunteer slot.
 */
export function validateVectorEmbedPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object'
  }
  const body = payload as Record<string, unknown>
  const text = body.text
  if (text !== undefined && typeof text !== 'string') {
    return 'payload.text must be a string'
  }
  if (typeof text === 'string' && text.length > 100000) {
    return 'payload.text exceeds 100000 characters'
  }
  const imageUrls = body.imageUrls ?? []
  if (body.imageUrls !== undefined && !Array.isArray(imageUrls)) {
    return 'payload.imageUrls must be an array'
  }
  if (Array.isArray(imageUrls) && imageUrls.length > 29) {
    return 'payload.imageUrls must hold 0..29 URLs'
  }
  for (const url of (Array.isArray(imageUrls) ? imageUrls : [])) {
    if (!isSafeMediaUrl(url)) {
      return 'payload.imageUrls must be public https:// URLs'
    }
  }
  const audioUrl = body.audioUrl
  if (audioUrl !== undefined && !isSafeMediaUrl(audioUrl)) {
    return 'payload.audioUrl must be a public https:// URL'
  }
  const videoUrl = body.videoUrl
  if (videoUrl !== undefined && !isSafeMediaUrl(videoUrl)) {
    return 'payload.videoUrl must be a public https:// URL'
  }
  const hasText = typeof text === 'string' && text.length > 0
  const hasMedia = (Array.isArray(imageUrls) && imageUrls.length > 0) || audioUrl !== undefined || videoUrl !== undefined
  if (body.engine !== undefined && body.engine !== 'transformers' && body.engine !== 'friedflaxia') {
    return 'payload.engine must be transformers or friedflaxia'
  }
  if (!hasText && !hasMedia) {
    return 'payload needs at least text or one media URL'
  }
  return null
}

/**
 * Validate a `cc-extract` payload at the API boundary.
 *
 * The node re-validates the same limits (defense in depth), but rejecting a bad
 * record set here keeps malformed or oversized WARC references out of the
 * queue, where they would otherwise occupy a volunteer slot before failing.
 */
export function validateCcExtractPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object'
  }
  const body = payload as Record<string, unknown>

  if (typeof body.crawl !== 'string' || !CC_CRAWL_PATTERN.test(body.crawl)) {
    return 'payload.crawl must be a CC-MAIN-YYYY-WW crawl id'
  }

  const records = body.records
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_CC_EXTRACT_RECORDS) {
    return `payload.records must contain 1..${MAX_CC_EXTRACT_RECORDS} records`
  }

  let totalBytes = 0
  for (const entry of records) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return 'payload.records entries must be objects'
    }
    const record = entry as Record<string, unknown>
    if (typeof record.url !== 'string' || !record.url || record.url.length > MAX_CC_EXTRACT_URL_CHARS) {
      return `payload.records[].url must be a non-empty string of at most ${MAX_CC_EXTRACT_URL_CHARS} characters`
    }
    try {
      const parsed = new URL(record.url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return 'payload.records[].url must be an http(s) URL'
      }
    } catch {
      return 'payload.records[].url must be a valid URL'
    }
    if (!ccWarcPathMatchesCrawl(record.warcFilename, body.crawl)) {
      return 'payload.records[].warcFilename must be a Common Crawl WARC object path for payload.crawl'
    }
    if (record.fetchUrl !== undefined) {
      if (typeof record.fetchUrl !== 'string' || record.fetchUrl.length > MAX_CC_EXTRACT_FETCH_URL_CHARS) {
        return `payload.records[].fetchUrl must be a string of at most ${MAX_CC_EXTRACT_FETCH_URL_CHARS} characters`
      }
      try {
        const parsed = new URL(record.fetchUrl)
        if (parsed.protocol !== 'https:') return 'payload.records[].fetchUrl must use https'
        if (parsed.username || parsed.password) return 'payload.records[].fetchUrl must not carry credentials'
        if (!isSafeMediaUrl(record.fetchUrl)) return 'payload.records[].fetchUrl must use a public https:// host'
      } catch {
        return 'payload.records[].fetchUrl must be a valid URL'
      }
    }
    if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
      return 'payload.records[].offset must be a non-negative integer'
    }
    if (
      !Number.isSafeInteger(record.length) ||
      (record.length as number) < 1 ||
      (record.length as number) > MAX_CC_EXTRACT_RECORD_BYTES
    ) {
      return `payload.records[].length must be within 1..${MAX_CC_EXTRACT_RECORD_BYTES}`
    }
    totalBytes += record.length as number
    if (record.languages !== undefined && typeof record.languages !== 'string') {
      return 'payload.records[].languages must be a string'
    }
    if (record.contentDigest !== undefined && typeof record.contentDigest !== 'string') {
      return 'payload.records[].contentDigest must be a string'
    }
  }
  if (totalBytes > MAX_CC_EXTRACT_TOTAL_BYTES) {
    return `payload.records total bytes must be <= ${MAX_CC_EXTRACT_TOTAL_BYTES}`
  }

  if (body.maxRecordBytes !== undefined) {
    const value = body.maxRecordBytes
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CC_EXTRACT_RECORD_BYTES) {
      return `payload.maxRecordBytes must be within 1..${MAX_CC_EXTRACT_RECORD_BYTES}`
    }
  }
  if (body.timeoutMs !== undefined) {
    const value = body.timeoutMs
    if (!Number.isSafeInteger(value) || (value as number) < 1000 || (value as number) > MAX_CC_EXTRACT_TIMEOUT_MS) {
      return `payload.timeoutMs must be within 1000..${MAX_CC_EXTRACT_TIMEOUT_MS}`
    }
  }

  return null
}

/**
 * Validate an `embed-gemma` payload at the API boundary. The node applies the
 * same caps before loading the 270M text model.
 */
export function validateEmbedGemmaPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object'
  }
  const body = payload as Record<string, unknown>
  const texts = body.texts
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBED_GEMMA_TEXTS) {
    return `payload.texts must contain 1..${MAX_EMBED_GEMMA_TEXTS} strings`
  }
  let totalChars = 0
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) {
      return 'payload.texts entries must be non-empty strings'
    }
    if (text.length > MAX_EMBED_GEMMA_TEXT_CHARS) {
      return `payload.texts entries must be at most ${MAX_EMBED_GEMMA_TEXT_CHARS} characters`
    }
    totalChars += text.length
  }
  if (totalChars > MAX_EMBED_GEMMA_TOTAL_CHARS) {
    return `payload.texts must total at most ${MAX_EMBED_GEMMA_TOTAL_CHARS} characters`
  }
  if (body.dimensions !== undefined && !isEmbedGemmaDimensions(body.dimensions)) {
    return 'payload.dimensions must be one of 768, 512, 256, 128'
  }
  if (body.engine !== undefined && body.engine !== 'transformers' && body.engine !== 'friedflaxia') {
    return 'payload.engine must be transformers or friedflaxia'
  }
  return null
}

/**
 * `allowedSites` is NOT IMPLEMENTED: there is no verified site identity, so the
 * coordinator skips every such task until its queue deadline. Reject the
 * submission instead of letting it sit in the queue and fail later. The
 * `TaskRecord` field remains for wire compatibility with older records.
 */
export function parseAllowedSites(payload: unknown): { sites?: string[]; error?: string } {
  if (!payload || typeof payload !== 'object') return {}
  const value = (payload as Record<string, unknown>).allowedSites
  if (value === undefined || value === null) return {}
  return { error: 'payload.allowedSites is unsupported (NOT IMPLEMENTED); submit without an allow-list' }
}

const app: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>()

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
  // Bound the body before parsing: register is unauthenticated, so an
  // arbitrarily large JSON body must not be buffered by the Worker.
  const rawBody = await c.req.text()
  if (!validatePayloadSize(c.env, rawBody)) return c.json({ error: 'Payload too large' }, 413)

  let body: {
    siteId?: string
    nodeId?: string
    capabilities?: string[]
    /** Theia LoRA experts this node can serve (theia-expert-<id>). */
    expertCapabilities?: unknown
    /** Whether this client understands the signed container fileSources field. */
    fileSources?: boolean
    deviceMemory?: number | null
    wasmMemoryBytes?: number
    warmModels?: unknown
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  // `siteId` remains accepted for compatibility, but it is an unauthenticated
  // claim. Coordinator scheduling deliberately does not use it for allowedSites.
  if (body?.siteId !== undefined && (typeof body.siteId !== 'string' || body.siteId.length > MAX_SITE_ID_CHARS)) {
    return c.json({ error: 'siteId must be a string of at most 128 characters' }, 400)
  }
  if (body?.fileSources !== undefined && typeof body.fileSources !== 'boolean') {
    return c.json({ error: 'fileSources must be a boolean' }, 400)
  }

  if (!Array.isArray(body?.capabilities) && body?.capabilities !== undefined) {
    return c.json({ error: 'capabilities must be an array of strings' }, 400)
  }
  const rawCapabilities = Array.isArray(body?.capabilities) ? body.capabilities : []
  if (rawCapabilities.length > MAX_NODE_CAPABILITIES) {
    return c.json({ error: `capabilities must hold at most ${MAX_NODE_CAPABILITIES} entries` }, 400)
  }
  const capabilities: string[] = []
  for (const cap of rawCapabilities) {
    if (typeof cap !== 'string') {
      return c.json({ error: 'capabilities must be an array of strings' }, 400)
    }
    if (!cap || cap.length > MAX_CAPABILITY_CHARS) {
      return c.json({ error: `capability entries must be non-empty and at most ${MAX_CAPABILITY_CHARS} characters` }, 400)
    }
    capabilities.push(cap)
  }

  // Expert capabilities are a signed scheduling claim: a node that advertises
  // one will be handed LoRA tasks for that expert. Validate the id with the
  // same guard the SDK and the node executor use, so a malformed capability
  // can never widen placement or become an invalid cache identity.
  if (body?.expertCapabilities !== undefined && !Array.isArray(body.expertCapabilities)) {
    return c.json({ error: 'expertCapabilities must be an array of capability strings' }, 400)
  }
  const rawExpertCapabilities = Array.isArray(body?.expertCapabilities) ? body.expertCapabilities : []
  if (rawExpertCapabilities.length > MAX_NODE_EXPERT_CAPABILITIES) {
    return c.json({ error: `expertCapabilities must hold at most ${MAX_NODE_EXPERT_CAPABILITIES} entries` }, 400)
  }
  const expertCapabilities: string[] = []
  for (const cap of rawExpertCapabilities) {
    if (!isTheiaExpertCapability(cap)) {
      return c.json({ error: 'expertCapabilities entries must be theia-expert-<id> strings' }, 400)
    }
    expertCapabilities.push(cap)
  }

  const fileSources = body.fileSources === true
  // Node identity is server-issued, always. A client-supplied `nodeId` is
  // ignored so it cannot register (and later connect) as another live node.
  const nodeId = crypto.randomUUID()

  if (!c.env.NODE_TOKEN_SECRET) {
    return c.json({ error: 'Node token secret is not configured' }, 503)
  }

  // Rate limit the unauthenticated register endpoint through the coordinator's
  // storage-backed limiter (shared across isolates), before signing a token.
  const rateStub = getCoordinator(c)
  const rateResponse = await rateStub.fetch(new Request('http://internal/register-rate', {
    headers: c.req.raw.headers,
  }))
  if (!rateResponse.ok) return c.json({ error: 'Rate limit exceeded' }, 429)

  // A `null`/undefined deviceMemory means a mobile WebView or unknown device.
  const deviceMemory = typeof body.deviceMemory === 'number' ? body.deviceMemory : null
  // Self-reported and only used to order candidates, so clamp it to a sane
  // ceiling: a node claiming 1e300 bytes must not dominate capacity ranking.
  const wasmMemoryBytes = clampByteCapacity(body.wasmMemoryBytes)

  const warmModels = parseWarmModels(body.warmModels)

  const exp = Date.now() + NODE_TOKEN_TTL_MS
  const token = await createNodeToken(c.env.NODE_TOKEN_SECRET, {
    siteId: body.siteId || '',
    nodeId,
    capabilities,
    expertCapabilities,
    fileSources,
    deviceMemory,
    wasmMemoryBytes,
    warmModels,
    exp,
  })

  return c.json({ token, nodeId, expiresAt: exp, lowMemory: isLowMemoryNode(wasmMemoryBytes, deviceMemory) })
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
  // Drop every claim the caller may have put in the URL. Only the verified
  // token below is allowed to populate them on the internal /ws request.
  url.searchParams.delete('expertCapabilities')
  url.searchParams.set('nodeId', payload.nodeId)
  url.searchParams.set('site', payload.siteId)
  url.searchParams.set('capabilities', payload.capabilities.join(','))
  // Expert capabilities come from the signed token, never from the socket's
  // query string, so a node cannot claim an expert it did not register.
  if (payload.expertCapabilities?.length) {
    url.searchParams.set('expertCapabilities', payload.expertCapabilities.join(','))
  }
  if (payload.fileSources) url.searchParams.set('fileSources', 'true')
  url.searchParams.set('lowMemory', String(isLowMemoryNode(payload.wasmMemoryBytes, payload.deviceMemory)))
  if (typeof payload.wasmMemoryBytes === 'number') {
    url.searchParams.set('wasm', String(payload.wasmMemoryBytes))
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

  let body: { workload?: string; payload?: unknown; timeoutMs?: number; callbackUrl?: string; priority?: unknown }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  if (typeof body.workload !== 'string' || !isRoutableWorkload(body.workload)) {
    return c.json({ error: 'Invalid workload type' }, 400)
  }
  if (!body.payload) return c.json({ error: 'payload is required' }, 400)
  if (body.priority !== undefined && !isTaskPriority(body.priority)) {
    return c.json({ error: 'priority must be an integer between 0 and 3' }, 400)
  }

  if (body.workload === 'cc-extract') {
    const extractError = validateCcExtractPayload(body.payload)
    if (extractError) return c.json({ error: extractError }, 400)
  }
  if (body.workload === 'embed-gemma') {
    const embedError = validateEmbedGemmaPayload(body.payload)
    if (embedError) return c.json({ error: embedError }, 400)
  }

  if (body.workload === 'ai-inference') {
    const aiError = validateAiInferencePayload(body.payload)
    if (aiError) return c.json({ error: aiError }, 400)
  }

  if (body.workload === 'vector-embed') {
    const embedError = validateVectorEmbedPayload(body.payload)
    if (embedError) return c.json({ error: embedError }, 400)
  }

  if (body.workload === 'theia-inference') {
    if (!isTheiaInferencePayload(body.payload)) {
      return c.json({ error: 'Invalid theia-inference payload' }, 400)
    }
    // The executor tokenizes the canvas; reject an oversized one here instead
    // of placing it on a warm node that will fail after downloading the model.
    const canvas = (body.payload as { canvas?: { text?: unknown } }).canvas
    if (typeof canvas?.text === 'string' && canvas.text.length > MAX_THEIA_CANVAS_CHARS) {
      return c.json({ error: 'theia-inference canvas exceeds the executor limit' }, 400)
    }
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
  const createdAt = Date.now()
  const task: TaskRecord = {
    id: taskId,
    status: 'pending',
    workload: body.workload as WorkloadType,
    payload: body.payload as TaskRecord['payload'],
    createdAt,
    queuedAt: createdAt,
    tenantId,
    allowedSites,
    priority: body.priority === undefined ? TASK_PRIORITY_DEFAULT : body.priority,
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

app.get('/queue/stats', async (c) => {
  const tenantId = await resolveCallerTenant(c.env, c.req.header('Authorization'))
  if (!tenantId) return c.json({ error: 'Unauthorized' }, 401)
  const stub = getCoordinator(c)
  const resp = await stub.fetch(`http://internal/queue-stats?tenantId=${encodeURIComponent(tenantId)}`)
  return new Response(resp.body, { status: resp.status, headers: resp.headers })
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
