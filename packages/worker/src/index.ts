import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { crowdApp } from './crowd'
import { originMatchesPattern } from './origin'
export { Coordinator } from './worker/Coordinator'

export interface Env {
  COORDINATOR: DurableObjectNamespace
  /** Comma-separated API keys: `key` or `key:tenantId`. */
  API_KEYS: string
  CORS_ORIGINS: string
  RATE_LIMIT_MAX: string
  MAX_PAYLOAD_SIZE: string
  /** Signs node registration tokens. */
  NODE_TOKEN_SECRET: string
  /**
   * Signs webhook deliveries. Dedicated so a leak in one plane does not forge
   * the other; when unset, tasks with a `callbackUrl` are rejected at submit
   * time instead of being delivered unsigned.
   */
  WEBHOOK_SIGNING_SECRET: string
  /** Signs short-lived `/crowd/subscribe` tokens (separate from node tokens). */
  SUBSCRIBE_TOKEN_SECRET: string
  /** Optional JSON object mapping tenant IDs to fair-queue weights from 1 to 4. */
  TENANT_SCHEDULING_WEIGHTS?: string
  /** Build metadata injected by scripts/deploy.mjs. */
  WORKER_VERSION?: string
  WORKER_COMMIT_SHA?: string
}

const app: Hono<{ Bindings: Env }> = new Hono<{ Bindings: Env }>()

const getOrigins = (env: Env | undefined): string[] => {
  if (!env) return ['*']
  const origins = env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)
  return origins && origins.length > 0 ? origins : ['http://localhost:5173', 'http://localhost:5174']
}

function getVersionInfo(env: Env | undefined) {
  return {
    service: 'flaxia-worker',
    version: env?.WORKER_VERSION || 'unknown',
    commit: env?.WORKER_COMMIT_SHA || 'unknown',
  }
}

const corsMiddleware = cors({
  origin: (origin, c) => {
    const allowed = getOrigins(c.env as Env | undefined)
    if (allowed.includes('*')) return origin || '*'
    if (!origin) return allowed[0]
    for (const pattern of allowed) {
      if (originMatchesPattern(origin, pattern)) return origin
    }
    return allowed[0]
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
})

app.get('/health', (c) => {
  const info = getVersionInfo(c.env as Env | undefined)
  return c.text('OK', 200, {
    'X-Worker-Version': info.version,
    'X-Worker-Commit': info.commit,
  })
})

app.get('/version', (c) => c.json(getVersionInfo(c.env as Env | undefined)))

app.use('/crowd/*', corsMiddleware)
app.route('/crowd', crowdApp)

export default app
