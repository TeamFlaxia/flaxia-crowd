/**
 * Resolve the orchestrator origin this demo talks to.
 *
 * The origin is build-time configuration only:
 *
 * - `VITE_ORCHESTRATOR_URL` — the orchestrator origin baked into the bundle.
 *   It is empty by default, so an unconfigured build fails loudly instead of
 *   silently pointing at production infrastructure.
 * - `VITE_ALLOWED_ORCHESTRATOR_ORIGINS` — comma-separated allowlist that gates
 *   the `flaxia_orchestrator_url` localStorage override. When the allowlist is
 *   empty (the default) every override is ignored, so a same-origin script
 *   cannot redirect node signaling (WebSocket) to an arbitrary origin. API
 *   calls never use this value: they always go through the same-origin
 *   `/crowd/*` proxy, which attaches the API key server-side.
 */

export const ORCHESTRATOR_URL_STORAGE_KEY = 'flaxia_orchestrator_url';

/**
 * Parse a value into a bare `http(s)` origin. Returns `null` for anything else
 * — credentials, paths, query strings and fragments are rejected so a stored
 * value can never smuggle a different request target past the allowlist.
 */
export function parseOrchestratorOrigin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;

  return url.origin;
}

/** Origins from `VITE_ALLOWED_ORCHESTRATOR_ORIGINS`, invalid entries dropped. */
export function getAllowedOrchestratorOrigins(): string[] {
  const raw = import.meta.env.VITE_ALLOWED_ORCHESTRATOR_ORIGINS;
  if (typeof raw !== 'string' || !raw.trim()) return [];

  const origins = new Set<string>();
  for (const entry of raw.split(',')) {
    const origin = parseOrchestratorOrigin(entry);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function readStoredOverride(): string | null {
  try {
    return localStorage.getItem(ORCHESTRATOR_URL_STORAGE_KEY);
  } catch {
    // localStorage can throw in privacy-restricted contexts.
    return null;
  }
}

/**
 * Resolve the orchestrator origin for this build.
 *
 * The localStorage override wins only when it is an exact match for an origin
 * in the build-time allowlist; otherwise it is ignored (with a console warning)
 * and the configured `VITE_ORCHESTRATOR_URL` is used. Returns `null` when the
 * build has no orchestrator configured, and callers must surface that to the
 * user instead of guessing a default.
 */
export function resolveOrchestratorUrl(): string | null {
  const configured = parseOrchestratorOrigin(import.meta.env.VITE_ORCHESTRATOR_URL);
  const allowed = getAllowedOrchestratorOrigins();
  const override = parseOrchestratorOrigin(readStoredOverride());

  if (override) {
    if (allowed.includes(override)) return override;
    console.warn(
      `[text-analyzer] ignoring localStorage["${ORCHESTRATOR_URL_STORAGE_KEY}"]: ` +
        `${override} is not in VITE_ALLOWED_ORCHESTRATOR_ORIGINS`,
    );
  }

  return configured;
}