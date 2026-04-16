/**
 * Shared CORS helper — Phase C cross-origin auth foundation.
 *
 * Used by the Phase C auth endpoints (`POST /api/auth/login`,
 * `POST /api/auth/logout`, `POST /api/auth/refresh`) and by the
 * existing `/api/client/*` endpoints when they gain Bearer token
 * support in Commit 5.
 *
 * Not used by `worker/src/routes/stripe.ts` — stripe.ts has its own
 * local CORS helper that predates this file. Migrating stripe.ts to
 * the shared helper is deliberately deferred per Phase C scope. The
 * existing stripe.ts behavior is unchanged.
 *
 * ── Origin whitelist
 *
 * Only the origins in `ALLOWED_ORIGINS` below can make authenticated
 * cross-origin fetches to the worker's JSON API. The three localhost
 * entries are for Phase D local development (Vite, React, wrangler
 * pages defaults). When a request arrives with an Origin header NOT
 * in the whitelist, the helper returns the default origin
 * (`https://advocatemcp.com`) in `Access-Control-Allow-Origin` rather
 * than echoing the unknown origin back — this prevents CORS confused-
 * deputy attacks where an attacker-controlled origin tricks the worker
 * into returning an `Allow-Origin: *.evil.com` header.
 *
 * ── Credentials mode
 *
 * `Access-Control-Allow-Credentials: true` is set ONLY when the caller
 * passes `opts.credentials = true`. This is a footgun setting per the
 * rearchitecture plan Section 6 — the only endpoints that need it are
 * `/api/auth/login`, `/api/auth/logout`, and `/api/auth/refresh`,
 * which read/write the refresh cookie. Every other endpoint leaves
 * credentials off.
 *
 * ── Vary: Origin
 *
 * Always included in the response headers so intermediate caches (CDN,
 * browser cache, etc.) don't serve a response with the wrong
 * `Allow-Origin` header to a different origin.
 */

/** Origins allowed to make authenticated cross-origin fetches to the worker. */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set<string>([
  "https://advocatemcp.com",
  "https://www.advocatemcp.com",
  // Local development — included for Phase D frontend dev velocity.
  // Harmless in production (a browser only sends an http://localhost:NNNN
  // Origin when actually running on localhost). Remove in a production
  // hardening pass if desired.
  "http://localhost:5173",  // Vite default
  "http://localhost:3000",  // React / Next default
  "http://localhost:8788",  // wrangler pages default
]);

export interface CorsOptions {
  /**
   * If true, sets `Access-Control-Allow-Credentials: true` on the
   * response. Enables the browser to include cookies in the request
   * and accept Set-Cookie in the response.
   *
   * Use only on `/api/auth/login`, `/api/auth/logout`, and
   * `/api/auth/refresh` — the endpoints that read or write the
   * refresh cookie. Every other endpoint should leave this
   * `undefined` or `false`. The credential mode reintroduces the
   * `Access-Control-Allow-Credentials` footgun described in the
   * rearchitecture plan Section 6; keeping it scoped to three
   * endpoints minimizes blast radius.
   */
  credentials?: boolean;
}

/**
 * Compute the CORS headers for a given request and options.
 *
 * Returns a plain object so callers can either spread it into an
 * existing headers object or pass it to `new Response(..., { headers })`.
 * Use `withCors` (below) to wrap an existing Response with these
 * headers, or `handleCorsPreflight` for OPTIONS preflight handlers.
 */
export function corsHeadersFor(
  request: Request,
  opts: CorsOptions = {},
): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://advocatemcp.com";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin":  allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Activation-Token",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };

  if (opts.credentials === true) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

/**
 * Wrap an existing Response with CORS headers. Clones the response's
 * existing headers (so the original Response object is not mutated),
 * adds the CORS headers on top of the clone, and returns a new
 * Response built from the original's body, status, statusText, and
 * the merged headers.
 *
 * The clone is important: mutating the original response's headers
 * directly can affect other references to the same Response object in
 * ways that aren't obvious at the call site. Always work on a fresh
 * Headers instance.
 */
export function withCors(
  response: Response,
  request: Request,
  opts: CorsOptions = {},
): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeadersFor(request, opts))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle a CORS preflight OPTIONS request. Returns a 204 No Content
 * Response with the CORS headers computed for the given request and
 * options.
 *
 * The 204 status is the conventional success code for preflight
 * responses — browsers accept any 2xx but 204 is the most explicit
 * "no body, no further content to process" signal.
 */
export function handleCorsPreflight(
  request: Request,
  opts: CorsOptions = {},
): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeadersFor(request, opts),
  });
}
