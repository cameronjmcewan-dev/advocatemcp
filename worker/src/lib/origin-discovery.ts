/**
 * Origin auto-discovery for Phase 2 self-serve activation.
 *
 * When `POST /admin/domains/activate` is called without an explicit
 * `origin_url`, we fetch `https://{domain}` with redirect following and take
 * the final URL's origin (scheme + host) as the customer's upstream. This
 * removes the "admin must know the underlying hostname" friction from
 * Phase 1 and unlocks self-serve onboarding for every future customer.
 *
 * Design notes:
 *
 *   - GET, not HEAD. HEAD-with-redirects is unreliable across hosting
 *     platforms — Squarespace, some WordPress setups, and a few CDNs return
 *     405 or mishandle Location on HEAD. GET is the only portable choice.
 *
 *   - Body is explicitly cancelled after the response arrives so the
 *     Workers runtime doesn't log an unconsumed-body warning. We only care
 *     about headers and the final URL.
 *
 *   - `response.url` reflects the post-redirect final URL when
 *     `redirect: "follow"` is used (Fetch spec). Safe to rely on across
 *     Workers, browsers, and undici.
 *
 *   - Self-loop check is strict equality on `hostname` (case-insensitive).
 *     No fuzzy "same organization" matching — www.example.com → example.com
 *     is a legitimate cross-hostname redirect from Cloudflare for SaaS's
 *     perspective, only one of them is registered as a custom hostname.
 *
 *   - Worker-hostname check reuses `WORKER_HOSTNAMES` from `proxy.ts` so
 *     the runtime proxy loop check and the activation-time discovery check
 *     can never drift.
 *
 *   - Known limitation: a domain fronted by Cloudflare with Under Attack
 *     Mode or a JS challenge will return 200 from its own hostname, hit
 *     the self_loop branch, and be rejected incorrectly. The error message
 *     tells the customer to pass origin_url explicitly as the workaround.
 *     Detecting CF challenge pages by sniffing headers is fragile (CF
 *     changes response shapes) and deferred to a future session once we
 *     have real incidence data.
 *
 *   - 10s timeout is intentionally generous — cold DNS + TLS handshake +
 *     redirect chain + TTFB can easily burn 4-5s on a real site. We are
 *     still well inside the Workers 30s wall-clock budget after the CF
 *     API call, D1 write, and KV writes that come after this.
 */

import { WORKER_HOSTNAMES } from "./proxy.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiscoveryRejectionReason =
  | "fetch_failed"   // network error, DNS failure, connection refused
  | "fetch_timeout"  // 10s budget exceeded
  | "origin_5xx"     // final response status >= 500
  | "http_scheme"    // final URL is not https (redirect downgraded)
  | "self_loop"      // final hostname equals the activation domain
  | "worker_loop";   // final hostname is a known AdvocateMCP Worker host

export interface DiscoveryOk {
  ok: true;
  /** scheme + host only, e.g. "https://example.squarespace.com" — no path or query */
  originUrl: string;
  /** hostname portion of the final URL, lowercased by URL parser */
  finalHostname: string;
}

export interface DiscoveryErr {
  ok: false;
  /** HTTP status for handleActivateDomain to surface — always 400 for now */
  status: number;
  error: string;
  reason: DiscoveryRejectionReason;
  detail: Record<string, unknown>;
}

/**
 * Minimal shape the production code reads from the fetch response. Defined
 * as an interface so tests can inject a plain object literal — the Response
 * constructor in undici/Node doesn't let you set `url`, which makes real
 * Response instances unusable for redirect-final-URL tests.
 *
 * If production code starts reading additional properties, update this
 * interface at the same time so tests stay in lockstep with reality.
 */
export interface FetchResponseLike {
  status: number;
  url: string;
  body: { cancel(): void | Promise<void> } | null;
}

export type FetchFn = (
  input: string,
  init?: { method?: string; redirect?: "follow" | "manual"; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<FetchResponseLike>;

// ── Constants ─────────────────────────────────────────────────────────────────

const DISCOVERY_USER_AGENT = "AdvocateMCP-Discovery/1.0 (+https://advocatemcp.com)";
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Main entry ────────────────────────────────────────────────────────────────

export async function discoverOriginUrl(
  domain: string,
  opts: {
    fetchFn?: FetchFn;
    timeoutMs?: number;
  } = {},
): Promise<DiscoveryOk | DiscoveryErr> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const normalizedDomain = domain.toLowerCase();
  const startUrl = `https://${normalizedDomain}`;

  let response: FetchResponseLike;
  try {
    response = await fetchFn(startUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": DISCOVERY_USER_AGENT },
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 400,
      reason: isAbort ? "fetch_timeout" : "fetch_failed",
      error: isAbort
        ? `Auto-discovery timed out fetching ${normalizedDomain} after ${timeoutMs / 1000} seconds. The domain may be slow or misconfigured — retry, or provide origin_url explicitly.`
        : `Auto-discovery could not reach ${normalizedDomain} — connection failed. Verify the domain is live and publicly resolvable, then retry, or provide origin_url explicitly.`,
      detail: {
        reason: isAbort ? "fetch_timeout" : "fetch_failed",
        domain: normalizedDomain,
        cause: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Release the body stream ASAP — we never need it.
  try {
    await response.body?.cancel();
  } catch {
    // body already cancelled or null — ignore
  }

  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    return {
      ok: false,
      status: 400,
      reason: "fetch_failed",
      error: `Auto-discovery received an unparseable final URL for ${normalizedDomain}. Provide origin_url explicitly.`,
      detail: { reason: "fetch_failed", domain: normalizedDomain, rawFinalUrl: response.url },
    };
  }

  const finalHostname = finalUrl.hostname.toLowerCase();

  // ── Rejection checks, in order ──────────────────────────────────────────────

  if (finalUrl.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      reason: "http_scheme",
      error: `Auto-discovered origin redirected to a non-HTTPS URL (${finalHostname}). Provide origin_url explicitly if the upstream really is HTTP (not recommended).`,
      detail: { reason: "http_scheme", domain: normalizedDomain, finalHostname, scheme: finalUrl.protocol },
    };
  }

  if (WORKER_HOSTNAMES.has(finalHostname)) {
    return {
      ok: false,
      status: 400,
      reason: "worker_loop",
      error: `Auto-discovered origin points at the AdvocateMCP Worker itself (${finalHostname}) — this would loop. The domain's DNS is probably already CNAMEd at customers.advocatemcp.com but no real upstream is configured. Provide origin_url explicitly.`,
      detail: { reason: "worker_loop", domain: normalizedDomain, finalHostname },
    };
  }

  // Three-way split on (cross-host redirect × 5xx status), in this order:
  //
  //   same-host  +  5xx   → fetch_failed (synthetic Workers response — DNS or
  //                         network failure; Workers does NOT throw TypeError
  //                         on unresolvable domains, it returns a 5xx-ish
  //                         response with the input URL preserved)
  //   same-host  +  <5xx  → self_loop    (real site responding at its own
  //                         hostname with no cross-host redirect)
  //   cross-host +  5xx   → origin_5xx   (real origin reached but sick)
  //   cross-host +  <5xx  → success (handled below)
  //
  // The same-host 5xx check MUST come before the self_loop check, otherwise
  // unresolvable domains get misreported as self_loop. See the regression
  // tests in origin-discovery.test.ts for the exact reproduction.
  if (finalHostname === normalizedDomain && response.status >= 500) {
    return {
      ok: false,
      status: 400,
      reason: "fetch_failed",
      error: `Auto-discovery could not reach ${normalizedDomain} — verify the domain is live, publicly resolvable, and responding to HTTPS requests, or provide origin_url explicitly.`,
      detail: {
        reason: "fetch_failed",
        domain: normalizedDomain,
        finalHostname,
        httpStatus: response.status,
        note: "same-host 5xx indicates a synthetic Cloudflare Workers error response (DNS or network failure), not an origin incident",
      },
    };
  }

  if (finalHostname === normalizedDomain) {
    return {
      ok: false,
      status: 400,
      reason: "self_loop",
      error: `Auto-discovery requires the domain to redirect to a different underlying host. ${normalizedDomain} appears to be its own origin (no cross-host redirect detected), which would cause a traffic loop. Either wait until the site is hosted on a platform that responds at a different hostname, or provide origin_url explicitly. If your site is behind Cloudflare with an Under Attack Mode or challenge page, provide origin_url explicitly — the challenge page masks the real upstream from auto-discovery.`,
      detail: { reason: "self_loop", domain: normalizedDomain, finalHostname },
    };
  }

  if (response.status >= 500) {
    return {
      ok: false,
      status: 400,
      reason: "origin_5xx",
      error: `Auto-discovery fetched ${finalHostname} and got HTTP ${response.status}. Retry once the site is healthy, or provide origin_url explicitly.`,
      detail: { reason: "origin_5xx", domain: normalizedDomain, finalHostname, httpStatus: response.status },
    };
  }

  // ── Success ─────────────────────────────────────────────────────────────────

  return {
    ok: true,
    originUrl: finalUrl.origin,
    finalHostname,
  };
}
