import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { crowdApp } from './crowd'
export { Coordinator } from './worker/Coordinator'

export interface Env {
  COORDINATOR: DurableObjectNamespace
  API_KEYS: string
  CORS_ORIGINS: string
  RATE_LIMIT_MAX: string
  MAX_PAYLOAD_SIZE: string
  NODE_TOKEN_SECRET: string
}

const app = new Hono<{ Bindings: Env }>()

const getOrigins = (env: Env | undefined): string[] => {
  if (!env) return ['*']
  const origins = env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean)
  return origins && origins.length > 0 ? origins : ['http://localhost:5173', 'http://localhost:5174']
}

const corsMiddleware = cors({
  origin: (origin, c) => {
    const allowed = getOrigins(c.env as Env | undefined)
    if (allowed.includes('*')) return origin || '*'
    if (!origin) return allowed[0]
    for (const pattern of allowed) {
      if (pattern === origin) return origin
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2)
        if (origin === suffix || origin.endsWith(`.${suffix}`)) return origin
      }
    }
    return allowed[0]
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
})

app.get('/health', (c) => c.text('OK'))

app.use('/crowd/*', corsMiddleware)
app.route('/crowd', crowdApp)

export default app
