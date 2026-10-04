/**
 * WebSocket handshake contract shared by the worker (server), the node client
 * and the requester SDK.
 *
 * A browser `WebSocket` cannot set request headers, so the bearer token travels
 * in the subprotocol list instead of the URL. A `?token=` query string ends up
 * in proxy/CDN access logs and in anything that copies the URL, so the server
 * rejects it outright. Both ends must agree on the exact protocol names and on
 * the `bearer.` prefix, which is why this lives in the SDK (single source of
 * truth, see GEMINI.md).
 *
 * Client side:
 * ```ts
 * new WebSocket(url, buildNodeSignalProtocols(token))
 * ```
 *
 * Server side:
 * ```ts
 * const bearer = parseBearerSubprotocol(req.headers.get('Sec-WebSocket-Protocol'), NODE_SIGNAL_PROTOCOL)
 * ```
 */

/** Subprotocol negotiated for `GET /crowd/signal` (node signaling). */
export const NODE_SIGNAL_PROTOCOL = 'flaxia-node-v1';

/** Subprotocol negotiated for `GET /crowd/subscribe` (requester result stream). */
export const SUBSCRIBE_PROTOCOL = 'flaxia-subscribe-v1';

/** Prefix that carries the bearer token as a synthetic subprotocol entry. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

/** Hard cap on a bearer token read off the wire (defensive header bound). */
export const MAX_BEARER_TOKEN_CHARS = 4096;

/** Subprotocol list a node offers on `/crowd/signal`. */
export function buildNodeSignalProtocols(token: string): string[] {
  return [NODE_SIGNAL_PROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`];
}

/** Subprotocol list a requester offers on `/crowd/subscribe`. */
export function buildSubscribeProtocols(token: string): string[] {
  return [SUBSCRIBE_PROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`];
}

export interface BearerSubprotocol {
  /** The named protocol that was negotiated (echoed on the 101 response). */
  protocol: string;
  /** The token from the single `bearer.<token>` entry. */
  token: string;
}

/**
 * Read the bearer token out of a `Sec-WebSocket-Protocol` header.
 *
 * Returns `null` unless the header offers exactly the expected protocol plus
 * one well-formed `bearer.` entry: a token must never be smuggled in through a
 * duplicate or unexpected entry, and unknown protocols are rejected so the
 * negotiated subprotocol is always unambiguous.
 */
export function parseBearerSubprotocol(
  header: string | null | undefined,
  protocol: string,
): BearerSubprotocol | null {
  if (!header) return null;
  const entries = header.split(',').map((entry) => entry.trim()).filter(Boolean);
  let sawProtocol = false;
  let token: string | null = null;

  for (const entry of entries) {
    if (entry === protocol) {
      if (sawProtocol) return null;
      sawProtocol = true;
      continue;
    }
    if (entry.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
      if (token !== null) return null;
      const value = entry.slice(BEARER_SUBPROTOCOL_PREFIX.length);
      if (!value || value.length > MAX_BEARER_TOKEN_CHARS) return null;
      token = value;
      continue;
    }
    return null;
  }

  if (!sawProtocol || token === null) return null;
  return { protocol, token };
}

/**
 * Build a WebSocket URL from an HTTP(S) base URL, a path and query params.
 * Keeps the worker's `/crowd/*` routes out of every caller's string handling.
 */
export function buildWsUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const wsBase = baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
  const url = new URL(`${wsBase}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}