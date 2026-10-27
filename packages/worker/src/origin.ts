/**
 * Match a serialized browser Origin header against one configured CORS origin.
 *
 * Exact origins are preferred. Wildcard host patterns may be written as
 * `https://*.example.com` (scheme-bound subdomains only) or `*.example.com`
 * (host suffix on any scheme).
 */
export function originMatchesPattern(origin: string, pattern: string): boolean {
  if (pattern === '*' || pattern === origin) return true

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin !== origin) return false

  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2).toLowerCase()
    return parsed.hostname !== suffix && parsed.hostname.endsWith(`.${suffix}`)
  }

  const match = /^([a-z][a-z\\d+.-]*):\\/\\/\\*\\.([^/:?#]+)$/i.exec(pattern)
  if (!match) return false
  const [, scheme, rawSuffix] = match
  const suffix = rawSuffix.toLowerCase()
  return parsed.protocol === `${scheme.toLowerCase()}:`
    && parsed.port === ''
    && parsed.hostname !== suffix
    && parsed.hostname.endsWith(`.${suffix}`)
}
