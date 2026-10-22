/**
 * Resolve the coordinator origin used only for the volunteer node's signaling
 * socket. Task API calls go through the same-origin server proxy in
 * `crowd-client.ts` and must not be redirected by browser storage.
 */
export function resolveOrchestratorUrl(raw: unknown, development: boolean): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 2048) return null;

  try {
    const url = new URL(raw.trim());
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (url.protocol === 'https:') return url.origin;

    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (development && isLoopback && url.protocol === 'http:') return url.origin;
  } catch {
    return null;
  }

  return null;
}
