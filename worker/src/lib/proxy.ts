/**
 * Transparent origin proxy for non-bot human traffic.
 *
 * Streams the origin response back to the browser with:
 *   - Same method, path, query string, and body as the incoming request
 *   - Request headers passed through; Host overridden to origin hostname
 *   - 3xx redirects passed through without following (redirect: "manual")
 *   - Cache-Control overridden to no-store (Phase 1 — relax once caching
 *     strategy per content type is defined)
 *   - WebSocket upgrade requests rejected with 501 (out of scope Phase 1)
 *   - HTTP/2 server push frames silently dropped by the Workers runtime
 *
 * Loop detection: returns 508 if the origin hostname matches any of the
 * known Worker hostnames or the incoming request's own hostname. This
 * prevents a misconfigured origin_url (e.g. origin CNAMEd back to the
 * Worker) from causing infinite recursion.
 *
 * Timeout: 30 seconds. Network failures and timeouts return 502.
 *
 * Set-Cookie: the Workers runtime preserves multiple Set-Cookie headers as
 * separate entries when iterating the Headers object. We construct a new
 * Headers from the origin response rather than mutating the immutable origin
 * headers, then set only Cache-Control on top. This pattern keeps all
 * Set-Cookie entries intact.
 */

/**
 * Hostnames owned by this Worker. Any origin_url pointing here is a loop.
 *
 * Exported so `worker/src/lib/origin-discovery.ts` can reuse the same set for
 * the Phase 2 auto-discovery loop check — we never want two independent lists
 * of Worker hostnames drifting out of sync. Add new Worker hostnames (preview
 * deployments, additional SaaS zones) here and both the runtime proxy check
 * and activation-time discovery pick them up together.
 */
export const WORKER_HOSTNAMES: ReadonlySet<string> = new Set([
  "customers.advocatemcp.com",
  "advocatecameron.workers.dev",
]);

export async function proxyToOrigin(
  request: Request,
  originUrl: string,
  /** Hostname of the incoming request — prevents same-domain self-loops. */
  requestHostname: string,
): Promise<Response> {
  const origin = new URL(originUrl);

  // Loop detection: origin must not resolve back to this Worker or to the
  // domain that issued this very request (the most common misconfiguration).
  if (WORKER_HOSTNAMES.has(origin.hostname) || origin.hostname === requestHostname) {
    return new Response(
      JSON.stringify({
        error: "Loop detected: origin_url resolves back to this Worker.",
        origin: origin.hostname,
        hint: "Set origin_url to the customer's real upstream server, not this domain.",
      }),
      { status: 508, headers: { "Content-Type": "application/json" } },
    );
  }

  // WebSocket upgrades are out of scope for Phase 1. Return 501 rather than
  // letting the fetch fail opaquely.
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return new Response(
      JSON.stringify({ error: "WebSocket proxying is not supported on this integration." }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  const requestUrl = new URL(request.url);
  // Preserve path and query string; replace scheme + host with origin.
  const target = new URL(requestUrl.pathname + requestUrl.search, originUrl);

  // Copy inbound headers and override Host to the origin hostname.
  // CF-specific pass-through headers (cf-ray, cf-connecting-ip, etc.) are
  // forwarded deliberately — origins use them for logging and rate limiting.
  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.set("Host", origin.host);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let originResponse: Response;
  try {
    originResponse = await fetch(target.toString(), {
      method: request.method,
      headers: outboundHeaders,
      // Pass body for non-idempotent methods. GET/HEAD must send null.
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
      // Pass 3xx through to the browser — do not follow redirects internally.
      // If the origin redirects to HTTP, the browser will show the warning.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "Origin request timed out after 30 seconds"
        : `Origin fetch failed: ${String(err)}`;
    return new Response(
      JSON.stringify({ error: reason, origin: origin.hostname }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
  clearTimeout(timeoutId);

  // Build response headers from the origin's headers, then override
  // Cache-Control. We do not strip Content-Encoding — compressed origin
  // responses (gzip, brotli) are passed through as-is with their
  // Content-Encoding header intact. The browser decompresses.
  const responseHeaders = new Headers(originResponse.headers);
  responseHeaders.set("Cache-Control", "no-store");

  return new Response(originResponse.body, {
    status: originResponse.status,
    headers: responseHeaders,
  });
}
