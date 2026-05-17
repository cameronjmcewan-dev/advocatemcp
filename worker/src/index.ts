/**
 * AdvocateMCP Cloudflare Worker
 *
 * Request routing (checked in order):
 *  1. Client portal  — /login, /auth/*, /dashboard, /api/client/*, /admin/create-client
 *  2. AI discovery   — /.well-known/ai-agent.json
 *  3. Non-crawler    — pass through (or info response in workers.dev mode)
 *  4. AI crawler     — resolve slug via KV → proxy to Railway agent API
 *
 * KV strategy (BUSINESS_MAP):
 *   Production — key = business domain hostname, value = slug
 *   Testing    — key = "advocatecameron.workers.dev", value = slug
 *   Path fallback — first path segment used as slug if KV has no hostname match
 */

import * as Sentry from "@sentry/cloudflare";
import type { Env } from "./types";
import { handlePortal } from "./routes/portal";
import { handleDemo } from "./routes/demo";
import { reconcileRailwaySync } from "./lib/railwayReconciler";
import { runGA4SyncBatch } from "./cron/ga4Sync";
import { runGSCSyncBatch } from "./cron/gscSync";
import { runCrmLtvSnapshotBatch } from "./cron/crmLtvSync";
import { runAuthoritySyncBatch } from "./cron/authoritySync";
import { verifyToken, base64urlToBytes } from "./lib/tracked-url";
import { buildSignedClickBody } from "./lib/clickBody";
import { getTenant } from "./routes/onboard";
import { proxyToOrigin, WORKER_HOSTNAMES } from "./lib/proxy";
import { wrapStreamForSentry } from "./lib/streamWithErrorCapture";
import { appendQuery } from "./lib/appendQuery";
import { mcpRateLimiter } from "./lib/mcpRateLimit";
import { checkMcpRateLimit, McpRateLimiterDO } from "./lib/mcpRateLimitDO";

// Durable Object class export — wrangler requires this to be a top-level
// export on the Worker entry module so the runtime can register the class
// for the `MCP_RATE_LIMITER` binding declared in wrangler.toml.
export { McpRateLimiterDO };

export type { Env };

// ── AI crawler User-Agent detection ────────────────────────────────────────

// Keep this list in lockstep with `server/src/prompts/index.ts::CANONICALS`.
//
// Two classes of crawler live here on purpose:
//
//   1. Batch indexers (*-Bot, *-Extended) — crawl on their own schedule,
//      build the AI's training corpus and search index.
//
//   2. Real-time user agents (*-User) — fetch WHEN a user asks the AI a
//      live question whose answer benefits from a current page read. These
//      are the ones that actually deliver AdvocateMCP's value during a
//      live conversation, because the structured agent response is what
//      the user sees in the answer panel. Missing a *-User agent from
//      this list means our worker serves scraped HTML to Perplexity/
//      ChatGPT when they're answering a live query — the exact failure
//      mode observed on the first paying tenant's domain before adding Perplexity-User.
const AI_CRAWLERS = [
  "PerplexityBot",
  "Perplexity-User",
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Google-Extended",
  "Googlebot",
  "GoogleOther",
  "Applebot-Extended",
  "anthropic-ai",
  "cohere-ai",
  "meta-externalagent",
] as const;

function isAiCrawler(ua: string): boolean {
  const lower = ua.toLowerCase();
  return AI_CRAWLERS.some((bot) => lower.includes(bot.toLowerCase()));
}

function crawlerName(ua: string): string | null {
  const lower = ua.toLowerCase();
  return AI_CRAWLERS.find((bot) => lower.includes(bot.toLowerCase())) ?? null;
}

// ── Analytics logging ──────────────────────────────────────────────────────

interface AnalyticsEvent {
  timestamp: string;
  hostname: string;
  path: string;
  method: string;
  userAgent: string;
  botType: string | null;
  slug: string | null;
  status: number;
  referralUrl: string | null;
  taggedReferralUrl: string | null;
  pagePath: string | null;
  latencyMs: number;
  error: string | null;
}

function logEvent(event: AnalyticsEvent): void {
  console.log(JSON.stringify({ advocatemcp: true, ...event }));
}

// ── IP hashing (SHA-256, Web Crypto — no node dep) ─────────────────────────

async function hashIp(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── UTM tagging ────────────────────────────────────────────────────────────

function utmTag(referralUrl: string | null, botType: string | null): string | null {
  if (!referralUrl) return null;
  try {
    const u = new URL(referralUrl);
    u.searchParams.set("utm_source", "ai");
    u.searchParams.set("utm_medium", "crawler");
    u.searchParams.set("utm_campaign", "advocatemcp");
    u.searchParams.set("utm_content", botType ?? "unknown");
    return u.toString();
  } catch {
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Best-effort: decode the payload half of a signed token to extract dest.
 * Used only on verification failure so the user still gets a 302.
 * Falls back to apiBase if the token is too malformed to decode.
 */
function safeFallbackDest(token: string, env: Env): string {
  try {
    const encodedPayload = token.slice(0, token.lastIndexOf("."));
    const json = new TextDecoder().decode(base64urlToBytes(encodedPayload));
    const parsed = JSON.parse(json) as { dest?: unknown };
    if (typeof parsed.dest === "string" && parsed.dest.startsWith("https://")) {
      return parsed.dest;
    }
  } catch { /* fall through */ }
  return apiBase(env);
}

function apiBase(env: Env): string {
  return env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
}

/**
 * Public-facing base URL embedded in `/.well-known/ai-agent.json` and any
 * other surface AI bots consume. Distinct from `apiBase` (the Worker's
 * INTERNAL fetch target) because AI assistants will quote / link these URLs
 * verbatim in their answers — they must be the branded customer-facing host,
 * never the raw Railway hostname. The fallback string is the production
 * default; in dev/test, set `PUBLIC_API_BASE_URL` on the Env.
 */
function publicApiBase(env: Env): string {
  return env.PUBLIC_API_BASE_URL ?? "https://api.advocatemcp.com";
}

function jsonError(status: number, message: string, detail?: unknown): Response {
  return new Response(
    JSON.stringify({ error: message, detail: detail ?? null }, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Powered-By": "AdvocateMCP",
      },
    }
  );
}

/**
 * Narrow `unknown` profile fields to a printable string. Handles the loose
 * `Record<string, unknown>` shape returned by `${apiBase}/agents/{slug}/profile`
 * — fields may be missing, null, numbers, or arrays. Returns null for unusable
 * values so the caller can `skip` the section.
 */
function asPrintableString(val: unknown): string | null {
  if (typeof val === "string") {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  return null;
}

/**
 * Coerce a profile field into a list of printable service / link strings.
 * Handles arrays of strings, arrays of `{name, ...}` objects, and the
 * occasional comma-separated single-string shape.
 */
function asPrintableList(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const named = (item as Record<string, unknown>).name;
          if (typeof named === "string") return named.trim();
        }
        return "";
      })
      .filter((s) => s.length > 0);
  }
  if (typeof val === "string" && val.trim().length > 0) {
    return val.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Build the markdown body for /llms.txt — the emerging convention from
 * llmstxt.org for AI-readable site discovery. Universally accessible (no UA
 * gating), per-tenant, generated from the same profile object that powers
 * ai-agent.json. Falls back to a generic AdvocateMCP-platform pointer when
 * the hostname doesn't map to a known tenant.
 *
 * Per-tenant: every customer's custom hostname gets their own llms.txt with
 * no per-tenant config — just whatever fields they've populated in their
 * stored profile drive what sections appear.
 */
export function buildLlmsTxtResponse(
  slug: string | null,
  env: Env,
  profile: Record<string, unknown> | null = null
): Response {
  const base = publicApiBase(env);

  let body: string;

  if (!slug || !profile) {
    // Generic platform-level fallback for unknown hostnames or missing
    // profile data. Points AI clients at the central registry rather than
    // serving an empty document.
    body = [
      "# AdvocateMCP",
      "",
      "> AI search visibility platform. Local businesses queryable via MCP — every tenant exposes a machine-readable agent at a stable endpoint.",
      "",
      "## Discovery",
      "",
      `- [Per-tenant ai-agent.json](/.well-known/ai-agent.json): JSON discovery file with agent endpoints + capabilities`,
      `- [Central MCP manifest](${base}/.well-known/mcp.json): MCP protocol manifest covering every registered tenant`,
      `- [Central agent endpoint](${base}/mcp): POST MCP JSON-RPC requests; spec-compliant Streamable HTTP transport`,
      "",
      "## For AI clients",
      "",
      "Each tenant exposes the same shape:",
      "",
      `- \`${base}/agents/{slug}/profile\` — structured business profile (JSON)`,
      `- \`${base}/agents/{slug}/query\` — POST \`{"query": string, "crawler": string}\` for a tailored, citation-ready answer`,
      "",
      "## More",
      "",
      "- [Site root](https://advocatemcp.com): human-facing marketing site",
      "",
    ].join("\n");
  } else {
    const name        = asPrintableString(profile.name) ?? slug;
    const description = asPrintableString(profile.description);
    const location    = asPrintableString(profile.location);
    const category    = asPrintableString(profile.category);
    const phone       = asPrintableString(profile.phone) ?? asPrintableString(profile.telephone);
    const email       = asPrintableString(profile.email);
    const referralUrl = asPrintableString(profile.referral_url) ?? asPrintableString(profile.website);
    const availability = asPrintableString(profile.availability) ?? asPrintableString(profile.hours);
    const serviceArea  = asPrintableString(profile.service_area)
                       ?? asPrintableString(profile.service_radius_miles)
                       ?? asPrintableString(profile.service_area_keywords);
    const services     = asPrintableList(profile.services).slice(0, 25);

    const lines: string[] = [];
    lines.push(`# ${name}`);
    lines.push("");
    if (description) {
      // First sentence only for the blockquote summary — keeps llms.txt
      // scannable. Fall back to full string if no sentence boundary.
      const summary = description.split(/(?<=[.!?])\s+/)[0] ?? description;
      lines.push(`> ${summary}`);
      lines.push("");
    }
    const subtitle = [location, phone].filter(Boolean).join(" · ");
    if (subtitle) {
      lines.push(subtitle);
      lines.push("");
    }

    if (services.length > 0) {
      lines.push("## Services");
      lines.push("");
      for (const s of services) lines.push(`- ${s}`);
      lines.push("");
    }

    lines.push("## Links");
    lines.push("");
    if (referralUrl) {
      lines.push(`- [Website](${referralUrl}): primary contact / booking surface`);
    }
    lines.push(`- [Machine-readable profile](/.well-known/ai-agent.json): JSON schema with endpoints + capabilities`);
    lines.push(`- [Direct agent query](${base}/agents/${slug}/query): POST \`{"query": string, "crawler": string}\` for a tailored, citation-ready answer`);
    lines.push(`- [Central MCP manifest](${base}/.well-known/mcp.json)`);
    lines.push("");

    const optional: string[] = [];
    if (category)     optional.push(`- Category: ${category}`);
    if (availability) optional.push(`- Availability: ${availability}`);
    if (serviceArea)  optional.push(`- Service area: ${serviceArea}`);
    if (email)        optional.push(`- Email: ${email}`);
    if (optional.length > 0) {
      lines.push("## Details");
      lines.push("");
      lines.push(...optional);
      lines.push("");
    }

    if (description && description.split(/(?<=[.!?])\s+/).length > 1) {
      lines.push("## About");
      lines.push("");
      lines.push(description);
      lines.push("");
    }

    body = lines.join("\n");
  }

  return new Response(body, {
    headers: {
      "Content-Type":  "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "X-Powered-By":  "AdvocateMCP",
    },
  });
}

export function buildWellKnownResponse(
  slug: string | null,
  env: Env,
  profile: Record<string, unknown> | null = null
): Response {
  // Public-facing manifest: bots will quote these URLs in their answers,
  // so use the branded host (publicApiBase), not the raw Railway hostname.
  const base = publicApiBase(env);
  const body: Record<string, unknown> = {
    spec_version: "1.0",
    spec_name: "ai-agent-discovery",
    agent_id: slug,
    agent_endpoint: slug ? `${base}/agents/${slug}/query` : `${base}/agents/{slug}/query`,
    profile_endpoint: slug ? `${base}/agents/${slug}/profile` : null,
    mcp_endpoint: `${base}/mcp`,
    manifest_url: `${base}/.well-known/mcp.json`,
    protocol: "advocatemcp-v1",
    capabilities: ["answer_queries", "referral", "availability"],
    crawler_instructions: slug
      ? `POST to agent_endpoint with JSON body { "query": string, "crawler": string } instead of scraping this page.`
      : `POST to agent_endpoint with JSON body { "query": string, "crawler": string }.`,
    powered_by: "AdvocateMCP",
  };
  if (profile) {
    body.business_name    = profile.name;
    body.business_category = profile.category;
    body.location         = profile.location;
    body.description      = profile.description;
    body.services         = profile.services;
    body.referral_url     = profile.referral_url;
    body.availability     = profile.availability;
  }
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Main fetch handler ─────────────────────────────────────────────────────

// Sentry-wrapped default export. `withSentry` takes a config-builder
// function (called once per request with the env) plus the underlying
// handler. When SENTRY_DSN is unset (dev/test), Sentry initializes
// with `dsn: undefined` and silently no-ops — no crashes, no leaks.
//
// `tracesSampleRate: 0.1` keeps perf tracing enabled but only on 10%
// of requests so we don't burn through the free-tier transaction
// quota. Errors are captured at 100%. Bump to 1.0 if you want full
// trace coverage and the quota allows.
//
// `sendDefaultPii: false` matches our privacy posture — IPs and full
// request/response bodies don't reach Sentry's servers. Anything we
// want surfaced (slug, request_id, agent_id) gets explicitly tagged
// in the relevant route handlers via `Sentry.setTag()`.
export default Sentry.withSentry(
  (env: Env) => ({
    dsn:               env.SENTRY_DSN,
    environment:       env.SENTRY_ENVIRONMENT ?? "production",
    release:           "advocatemcp-worker",
    // 10% sample rate keeps perf tracing on for hot paths while
    // staying well under the free-tier 10k transactions/month quota.
    // Errors are always captured at 100%.
    tracesSampleRate:  0.1,
    sendDefaultPii:    false,
  }),
  {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs    = Date.now();
    const url        = new URL(request.url);
    const domain     = url.hostname;
    const userAgent  = request.headers.get("User-Agent") ?? "";
    const timestamp  = new Date(startMs).toISOString();
    const botType    = crawlerName(userAgent);

    // Apr 28 2026 verification endpoint. GET /__sentry-test forces a
    // synthetic captureMessage with explicit flush + waitUntil so the
    // event actually reaches Sentry before the worker terminates.
    //
    // Critical detail for Cloudflare Workers: captureMessage returns
    // an event ID synchronously, but the underlying transport sends
    // the event over the network — async. Without `ctx.waitUntil()`
    // the Worker runtime kills the request after the response goes
    // out, dropping the in-flight Sentry event.
    //
    // Sentry.flush() returns a Promise<boolean> — true if the queue
    // drained successfully, false if there was a transport error.
    // We expose the flushed status in the response so we can tell
    // 'event accepted by SDK' apart from 'event delivered to Sentry'.
    if (url.pathname === "/__sentry-test" && request.method === "GET") {
      const id = Sentry.captureException(
        new Error(`worker test event ${new Date().toISOString()}`),
      );
      const flushed = await Sentry.flush(5000);
      // Echo back the DSN host (NOT the full DSN with key) so we can
      // confirm the worker is sending to the project we expect. The
      // host contains the org-id slug and the project-id is the last
      // path segment. If host is wrong, events go to the wrong org.
      let dsn_host = "unknown";
      let project_id = "unknown";
      let parse_err = "none";
      const dsn = env.SENTRY_DSN ?? "";
      try {
        if (dsn) {
          const u = new URL(dsn);
          dsn_host = u.host;
          project_id = u.pathname.replace(/^\//, "");
        }
      } catch (e: any) { parse_err = String(e?.message ?? e); }
      // Reveal the structure without leaking the public key. The
      // public key is the part between `://` and `@` — masked.
      const dsn_redacted = dsn
        .replace(/(\/\/)[^@]+@/, "$1<KEY>@")
        .slice(0, 200);
      return new Response(
        JSON.stringify({
          ok:               true,
          sentry_event_id:  id,
          flushed,
          dsn_configured:   !!env.SENTRY_DSN,
          dsn_length:       dsn.length,
          dsn_starts_with:  dsn.slice(0, 8),
          dsn_redacted,
          dsn_host,
          project_id,
          parse_err,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const baseEvent = {
      timestamp, hostname: domain, path: url.pathname,
      method: request.method, userAgent, botType,
      slug: null as string | null, pagePath: null as string | null,
    };

    // ── 1. Client portal routes ───────────────────────────────────────────
    // Checked before crawler logic — these are always human/API requests.
    const portalResponse = await handlePortal(request, env);
    if (portalResponse) return portalResponse;

    // ── 1b. Public demo pages — /demo, /demo/search, /demo/:slug ─────────
    const demoResponse = await handleDemo(request, env);
    if (demoResponse) return demoResponse;

    // ── 1b'. Per-platform context URLs (Phase 2 grey-hat, Apr 28 2026) ────
    // /(claude|perplexity|openai|google)-context on every customer host
    // (and advocatemcp.com) maps to the platform-context server route,
    // which forces the matching renderer regardless of the request UA.
    // The slug is the BUSINESS_MAP value for the request hostname.
    //
    // Edge-cached (TTL 600s) per the plan's "(host × path)" key. Each
    // call to the server fires a fresh Anthropic call (~3-7s) so without
    // the worker cache, every bot crawl pays full latency. Cache key
    // includes domain + pathname; invalidation is implicit on TTL
    // expiry. Profile edits land in the next 10-min window.
    {
      const m = url.pathname.match(/^\/(claude|perplexity|openai|google)-context\/?$/);
      if (m && request.method === "GET") {
        const platform = m[1]!;
        const slug = await env.BUSINESS_MAP.get(domain);
        if (!slug) {
          return new Response(
            JSON.stringify({
              error: "no_slug_for_host",
              hint:  "This host has no AdvocateMCP business mapping in KV.",
              host:  domain,
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }
        // Edge-cache key. Same shape as the existing per-bot HTML cache
        // at line ~724 — slug × platform × pathname. Use a synthetic
        // host so the key is independent of incoming protocol/zone
        // quirks (the cache.match() / put() on Cloudflare requires a
        // valid Request to use as key).
        const cacheKey = `https://cache.advocatemcp.com/v1/platform-context/${slug}/${platform}${url.pathname}`;
        let cacheStatus: "HIT" | "MISS" = "MISS";
        try {
          const cached = await caches.default.match(cacheKey);
          if (cached) {
            cacheStatus = "HIT";
            // Add observability header on cache hit; otherwise stream
            // the cached response through unchanged.
            const headers = new Headers(cached.headers);
            headers.set("X-Platform-Context", platform);
            headers.set("X-Agent-Slug",       slug);
            headers.set("X-Cache-Status",     "HIT");
            return new Response(cached.body, { status: cached.status, headers });
          }
        } catch (_) { /* cache infra blip — fall through to fresh fetch */ }

        const target = `${apiBase(env)}/agents/${slug}/context/${platform}`;
        try {
          const resp = await fetch(target, {
            method:  "GET",
            headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
          });
          // Buffer the body once so we can both put it in cache AND
          // return it. Streaming response bodies are single-use.
          const html = await resp.text();
          // Persist to edge cache with 600s TTL — matches plan's
          // "host + path + ?v={profile_version}" intent. Bumping
          // profile_version on PATCH is a future refinement; current
          // 10-min TTL is short enough that profile edits propagate
          // within the same cron tick window.
          const cacheableResp = new Response(html, {
            status: resp.status,
            headers: {
              "Content-Type": resp.headers.get("content-type") ?? "text/html; charset=utf-8",
              "Cache-Control": "public, max-age=600, s-maxage=600",
              ...(resp.headers.get("x-renderer-variant")
                ? { "X-Renderer-Variant": resp.headers.get("x-renderer-variant")! }
                : {}),
            },
          });
          ctx.waitUntil(caches.default.put(cacheKey, cacheableResp.clone()));

          return new Response(html, {
            status: resp.status,
            headers: {
              "Content-Type":       resp.headers.get("content-type") ?? "text/html; charset=utf-8",
              "X-Platform-Context": platform,
              "X-Agent-Slug":       slug,
              "X-Cache-Status":     cacheStatus,
              // no-store on the public response so downstream CDNs
              // don't double-cache. Our edge is the source of truth.
              "Cache-Control":      "no-store",
              ...(resp.headers.get("x-renderer-variant")
                ? { "X-Renderer-Variant": resp.headers.get("x-renderer-variant")! }
                : {}),
            },
          });
        } catch (err) {
          return jsonError(502, "Platform context unreachable.", { target, error: String(err) });
        }
      }
    }

    // ── 1b''. Synthetic landing pages (Phase 3 grey-hat, Apr 28 2026) ─────
    // Match three intent prefixes on every host:
    //   /best-{service}-in-{location}        → best_top
    //   /affordable-{service}-in-{location}  → affordable
    //   /emergency-{service}-near-{location} → emergency
    //
    // The catch-all /{service}-in-{location} (specific_service) is NOT
    // matched here — it would collide with arbitrary marketing paths
    // on customer domains (e.g. /about-in-portland). Those rows are
    // reachable directly via the server route /synthetic/:host/* but
    // the worker only forwards the three explicit prefixes.
    //
    // Forward to api.advocatemcp.com/synthetic/{host}{path}; the server
    // looks up status='live' rows and renders the stored body. 24-hour
    // edge cache (the plan's "host + path" key — no profile_version
    // appended because synthetic pages regenerate on a quarterly cron,
    // not on every profile PATCH).
    {
      const m = url.pathname.match(
        /^\/(best-[a-z0-9-]+-in-[a-z0-9-]+|affordable-[a-z0-9-]+-in-[a-z0-9-]+|emergency-[a-z0-9-]+-near-[a-z0-9-]+)\/?$/,
      );
      if (m && request.method === "GET") {
        const cacheKey = `https://cache.advocatemcp.com/v1/synthetic/${domain}${url.pathname}`;
        let cacheStatus: "HIT" | "MISS" = "MISS";
        try {
          const cached = await caches.default.match(cacheKey);
          if (cached) {
            cacheStatus = "HIT";
            const headers = new Headers(cached.headers);
            headers.set("X-Synthetic-Host", domain);
            headers.set("X-Cache-Status",   "HIT");
            return new Response(cached.body, { status: cached.status, headers });
          }
        } catch (_) { /* cache infra blip — fall through to fresh fetch */ }

        // Pass the request hostname as :host (URL-encoded). The server
        // looks up the row by (host, path) where status='live'. Customer
        // domains and advocatemcp.com both work because the server stores
        // the host on every row at generation time.
        const target = `${apiBase(env)}/synthetic/${encodeURIComponent(domain)}${url.pathname}`;
        try {
          const resp = await fetch(target, {
            method:  "GET",
            headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
          });
          // 404 from the server means no row matches this (host, path).
          // Return the 404 directly without caching — generation may
          // populate it before the next request, and we don't want to
          // pin a "missing" verdict for 24 hours.
          if (resp.status === 404) {
            return new Response(await resp.text(), {
              status: 404,
              headers: {
                "Content-Type":   resp.headers.get("content-type") ?? "application/json",
                "X-Cache-Status": cacheStatus,
                // Heal any stale entry pinned by a previous bug or
                // upstream blip (see compare-handler comment below).
                "Cache-Control":  "no-store",
              },
            });
          }
          const html = await resp.text();
          // ONLY cache 200 responses. A previous version of this handler
          // cached every non-404 response which let a transient Railway
          // 502 (during redeploy) get pinned for 24h. If the upstream
          // is sick, also delete any stale entry so the cache heals on
          // the next request rather than waiting for TTL.
          if (resp.status === 200) {
            const cacheableResp = new Response(html, {
              status: 200,
              headers: {
                "Content-Type":  resp.headers.get("content-type") ?? "text/html; charset=utf-8",
                "Cache-Control": "public, max-age=86400, s-maxage=86400",
              },
            });
            ctx.waitUntil(caches.default.put(cacheKey, cacheableResp.clone()));
          } else {
            ctx.waitUntil(caches.default.delete(cacheKey));
          }

          return new Response(html, {
            status: resp.status,
            headers: {
              "Content-Type":     resp.headers.get("content-type") ?? "text/html; charset=utf-8",
              "X-Synthetic-Host": domain,
              "X-Cache-Status":   cacheStatus,
              // Only set a long Cache-Control when we got a real 200.
              "Cache-Control":    resp.status === 200 ? "public, max-age=86400" : "no-store",
            },
          });
        } catch (err) {
          return jsonError(502, "Synthetic page unreachable.", { target, error: String(err) });
        }
      }
    }

    // ── 1b'''. Comparison pages (Phase 4 grey-hat, Apr 28 2026) ──────────
    // Match `/compare/{customer-slug}-vs-{competitor-slug}` on every host.
    // Forward to api.advocatemcp.com/compare/{host}{path}; the server
    // returns the matching status='live' row from `comparison_pages`.
    //
    // Strict-validator gate at generation time means the table stays
    // empty until an operator populates competitors.verified_facts_json
    // — so this matcher is functionally dormant until that data lands,
    // and 404 responses are NOT cached so freshly-generated rows go
    // live on the next request without a 24h TTL wait.
    {
      const m = url.pathname.match(/^\/compare\/[a-z0-9-]+-vs-[a-z0-9-]+\/?$/);
      if (m && request.method === "GET") {
        // MEDIUM-4 normalize: strip leading www. so a request to
        // www.foo.com finds the same row as foo.com. The server stores
        // host without the www. prefix (see comparisonPagesBuilder).
        const normalizedHost = domain.replace(/^www\./i, "");
        const cacheKey = `https://cache.advocatemcp.com/v1/compare/${normalizedHost}${url.pathname}`;
        let cacheStatus: "HIT" | "MISS" = "MISS";
        try {
          const cached = await caches.default.match(cacheKey);
          if (cached) {
            cacheStatus = "HIT";
            const headers = new Headers(cached.headers);
            headers.set("X-Compare-Host",  domain);
            headers.set("X-Cache-Status",  "HIT");
            return new Response(cached.body, { status: cached.status, headers });
          }
        } catch (_) { /* cache infra blip — fall through to fresh fetch */ }

        const target = `${apiBase(env)}/compare/${encodeURIComponent(normalizedHost)}${url.pathname}`;
        try {
          const resp = await fetch(target, {
            method:  "GET",
            headers: env.API_KEY ? { "X-API-Key": env.API_KEY } : {},
          });
          if (resp.status === 404) {
            // 404 not cached — strict-validator failures or missing
            // competitor facts may resolve before next request.
            return new Response(await resp.text(), {
              status: 404,
              headers: {
                "Content-Type":   resp.headers.get("content-type") ?? "application/json",
                "X-Cache-Status": cacheStatus,
                "Cache-Control":  "no-store",
              },
            });
          }
          const html = await resp.text();
          // ONLY cache 200 responses. A previous version cached every
          // non-404 response which pinned a transient Railway 502 for
          // 24h during the redeploy of the path-doubling fix. If the
          // upstream is sick, delete any stale entry so the cache heals
          // on the next request rather than waiting for TTL expiry.
          if (resp.status === 200) {
            const cacheableResp = new Response(html, {
              status: 200,
              headers: {
                "Content-Type":  resp.headers.get("content-type") ?? "text/html; charset=utf-8",
                // 24h cache parity with synthetic pages.
                "Cache-Control": "public, max-age=86400, s-maxage=86400",
              },
            });
            ctx.waitUntil(caches.default.put(cacheKey, cacheableResp.clone()));
          } else {
            ctx.waitUntil(caches.default.delete(cacheKey));
          }

          return new Response(html, {
            status: resp.status,
            headers: {
              "Content-Type":   resp.headers.get("content-type") ?? "text/html; charset=utf-8",
              "X-Compare-Host": domain,
              "X-Cache-Status": cacheStatus,
              "Cache-Control":  resp.status === 200 ? "public, max-age=86400" : "no-store",
            },
          });
        } catch (err) {
          return jsonError(502, "Comparison page unreachable.", { target, error: String(err) });
        }
      }
    }

    // ── 1c. Referral-click redirect — GET /track ─────────────────────────
    // Dual-path: signed token (?t=) preferred, legacy cleartext (?to=) fallback.
    // Bot-filtered: click logging only fires for non-crawler User-Agents.
    if (url.pathname === "/track" && request.method === "GET") {
      const ip = (
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        ""
      );

      const tokenParam = url.searchParams.get("t");
      if (tokenParam && env.TOKEN_SIGNING_KEY) {
        // ── Signed-token path ───────────────────────────────────────────────
        try {
          const payload = await verifyToken(tokenParam, env.TOKEN_SIGNING_KEY);
          if (!isAiCrawler(userAgent)) {
            ctx.waitUntil(
              hashIp(ip).then((ip_hash) =>
                fetch(`${apiBase(env)}/analytics/${payload.slug}/referral-click`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(
                    // Session 11.5: forward the verified token's aid claim so
                    // the server can stamp click_events.agent_id directly.
                    // Body shape stays back-compat (aid-less tokens omit the
                    // key entirely so server-side derivation from queries
                    // remains the fallback).
                    buildSignedClickBody({ payload, userAgent, ipHash: ip_hash }),
                  ),
                }).catch(() => { /* best-effort */ })
              )
            );
            console.log(JSON.stringify({ metric: "track_signed_click", slug: payload.slug, query_id: payload.query_id, ts: payload.ts }));
          }
          // Session 5: forward the token on the redirect target as `amcp_t`
          // so the customer's landing-page script can read it, POST to
          // `/r/:token/decode` on the Railway API, and personalize based on
          // intent/ref. Namespaced (`amcp_t`, not `t`) to avoid collisions
          // with whatever query-string params the customer's own site uses.
          // Only human redirects carry the token — AI-crawler redirects skip
          // it because crawlers don't run the client script anyway.
          const redirectTarget = isAiCrawler(userAgent)
            ? payload.dest
            : appendQuery(payload.dest, "amcp_t", tokenParam);
          return Response.redirect(redirectTarget, 302);
        } catch (err) {
          // err is TokenError ("malformed" | "bad_signature" | "expired")
          // User still gets a redirect; no click is logged for bad tokens.
          console.log(JSON.stringify({ metric: "track_verification_failure", reason: String(err) }));
          return Response.redirect(safeFallbackDest(tokenParam, env), 302);
        }
      }

      // ── Legacy path (?to=&ref=&client=) ────────────────────────────────────
      // Pre-Session-1 Worker tokens use cleartext params. Kept until signed-token
      // traffic reaches ~100% and legacy=1 rows decay to zero.
      const dest   = url.searchParams.get("to");
      const ref    = url.searchParams.get("ref") ?? "unknown";
      const client = url.searchParams.get("client");
      const target = dest ?? apiBase(env);
      if (dest && client && !isAiCrawler(userAgent)) {
        ctx.waitUntil(
          hashIp(ip).then((ip_hash) =>
            fetch(`${apiBase(env)}/analytics/${client}/referral-click`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ref, user_agent: userAgent, ip_hash, legacy: 1 }),
            }).catch(() => { /* best-effort */ })
          )
        );
        console.log(JSON.stringify({ metric: "track_legacy_click", slug: client }));
      }
      return Response.redirect(target, 302);
    }

    // ── 2. Platform MCP endpoint — proxy directly to backend ─────────────
    // Must be checked before crawler/slug logic so "/mcp" is never treated
    // as a business slug.
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Session 3: per-IP rate limit before proxying.
      //
      // Primary: Durable Object (global coherence across every CF edge).
      // Fallback: in-memory isolate-local limiter, used when the DO is
      // unreachable (DO outage, missing binding in dev, transient error).
      // The fallback is imperfect — an attacker hitting multiple edges
      // during a DO outage could multiply their limit — but it beats
      // serving `/mcp` with zero rate limiting.
      const ip = (
        request.headers.get("cf-connecting-ip") ??
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        ""
      );
      let decision = await checkMcpRateLimit(env, ip);
      let rateLimitSource: "do" | "isolate_fallback" = "do";
      if (!decision) {
        decision = mcpRateLimiter.check(ip);
        rateLimitSource = "isolate_fallback";
        console.log(JSON.stringify({ metric: "mcp_rate_limit_do_unreachable" }));
      }
      if (!decision.allowed) {
        console.log(JSON.stringify({
          metric: "mcp_rate_limited", ip_len: ip.length, path: url.pathname,
          limit: decision.limit, retry_after_s: decision.retryAfter,
          source: rateLimitSource,
        }));
        return new Response(JSON.stringify({
          error: "rate_limited",
          limit: decision.limit,
          retry_after_seconds: decision.retryAfter,
        }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After":  String(decision.retryAfter),
            "X-RateLimit-Limit":     String(decision.limit),
            "X-RateLimit-Remaining": "0",
          },
        });
      }

      const base = apiBase(env);
      const target = `${base}${url.pathname}${url.search}`;
      const startedAt = Date.now();
      try {
        const resp = await fetch(target, {
          method: request.method,
          headers: {
            ...Object.fromEntries(request.headers),
            ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
          },
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
        // Session 3 structured log: one line per /mcp proxy outcome so we
        // can observe directory-driven traffic shape + error rate. Does NOT
        // log tool name / payload — that's on the Railway side via
        // agent_requests (Session 11).
        console.log(JSON.stringify({
          metric: "mcp_proxy", path: url.pathname, method: request.method,
          status: resp.status, latency_ms: Date.now() - startedAt,
          remaining: decision.remaining, source: rateLimitSource,
        }));
        return new Response(
          wrapStreamForSentry(resp.body, {
            tag: "mcp_proxy",
            originHost: new URL(target).hostname,
            path: url.pathname,
          }),
          {
            status: resp.status,
            headers: resp.headers,
          },
        );
      } catch (err) {
        console.log(JSON.stringify({
          metric: "mcp_proxy_error", path: url.pathname, method: request.method,
          latency_ms: Date.now() - startedAt, error: String(err).slice(0, 200),
        }));
        return jsonError(502, "Platform MCP endpoint unreachable.", { target, error: String(err) });
      }
    }

    // ── 2d. api.advocatemcp.com passthrough — proxy everything to Railway ──
    // The `api.advocatemcp.com` hostname is the public API subdomain. It has
    // no origin server of its own — every request routes through this worker
    // and forwards to Railway. Worker-special paths like /mcp already handled
    // above (rate limit, structured logging) still fire first; this block
    // catches every OTHER path (/audit/run, /r/:token/decode, /register,
    // /agents/:slug/query, etc.) and proxies it straight through.
    //
    // Without this block, api.advocatemcp.com falls into the bot-detection
    // KV lookup below, which looks for a tenant slug mapped to the hostname,
    // finds none, and returns "Non-crawler request" to the caller — the
    // failure mode observed on POST /audit/run from curl.
    if (domain === "api.advocatemcp.com") {
      const base = apiBase(env);
      const target = `${base}${url.pathname}${url.search}`;
      try {
        const resp = await fetch(target, {
          method: request.method,
          headers: {
            ...Object.fromEntries(request.headers),
            ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
          },
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
        return new Response(
          wrapStreamForSentry(resp.body, {
            tag: "api_passthrough",
            originHost: new URL(target).hostname,
            path: url.pathname,
          }),
          {
            status: resp.status,
            headers: resp.headers,
          },
        );
      } catch (err) {
        console.log(JSON.stringify({
          metric: "api_proxy_error", path: url.pathname, error: String(err).slice(0, 200),
        }));
        return jsonError(502, "Public API unreachable.", { target, error: String(err) });
      }
    }

    // ── 2c. Platform agent endpoint — POST /agents/:slug/query ────────────
    // Direct proxy of POST /agents/:slug/query on platform hostnames only
    // (customers.advocatemcp.com, *.workers.dev). Fixes Phase 1.5 Bug 1:
    // the downstream bot-detection path's first-path-segment slug fallback
    // at (4) resolved the slug as "agents" for this URL shape, producing
    // a malformed /agents/agents/query downstream URL on Railway. Keeping
    // this as a separate early-dispatch route means the slug is pulled
    // from the URL path explicitly instead of from the fallback, and the
    // bot-detection flow on real customer domains (where the slug comes
    // from KV) is unchanged.
    //
    // Scoped via WORKER_HOSTNAMES (shared with proxy.ts loop detection
    // and origin-discovery.ts) so real customer-domain traffic continues
    // to flow through the bot-detection path at (4) byte-for-byte
    // unchanged. Any expansion of this route's reach should be a separate
    // session, not a Phase 1.5 side effect.
    //
    // Body forwarding: `request.body` is a ReadableStream and Workers
    // runtime passes it through the downstream fetch correctly for POST.
    // If production observation ever shows the body being lost or
    // duplicated, the fallback is to `await request.text()` and forward
    // the string — but that defeats streaming and is strictly a last
    // resort.
    {
      const agentMatch = /^\/agents\/([^/]+)\/query$/.exec(url.pathname);
      if (
        agentMatch &&
        request.method === "POST" &&
        WORKER_HOSTNAMES.has(domain)
      ) {
        const slugFromPath = agentMatch[1]!;
        const base = apiBase(env);
        const target = `${base}/agents/${slugFromPath}/query`;
        try {
          const resp = await fetch(target, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
            },
            body: request.body,
          });
          return new Response(
            wrapStreamForSentry(resp.body, {
              tag: "platform_agent_query",
              originHost: new URL(target).hostname,
              path: `/agents/${slugFromPath}/query`,
            }),
            {
              status: resp.status,
              headers: resp.headers,
            },
          );
        } catch (err) {
          console.log(JSON.stringify({
            metric: "platform_agent_proxy_error",
            target,
            error: String(err),
          }));
          return jsonError(502, "Backend unreachable.", { target, error: String(err) });
        }
      }
    }

    // ── 2b. AI discovery file ─────────────────────────────────────────────
    if (url.pathname === "/.well-known/ai-agent.json") {
      const slug = await env.BUSINESS_MAP.get(domain);
      // Fetch rich profile from backend if slug is known (best-effort, short timeout)
      let profile: Record<string, unknown> | null = null;
      if (slug) {
        try {
          const pr = await Promise.race([
            fetch(`${apiBase(env)}/agents/${slug}/profile`),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
          ]) as Response;
          if (pr.ok) profile = await pr.json() as Record<string, unknown>;
        } catch { /* best-effort */ }
      }
      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug, status: 200, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: null })
        )
      );
      return buildWellKnownResponse(slug, env, profile);
    }

    // ── 2c. /llms.txt ─────────────────────────────────────────────────────
    // Emerging convention from llmstxt.org — a per-site markdown discovery
    // file AI tools increasingly look for alongside robots.txt and sitemap.
    // Universally accessible (no UA gating). Per-tenant: same resolution
    // chain as ai-agent.json (BUSINESS_MAP → profile fetch). For tenants
    // with no profile (unknown hostnames), serves a platform-level
    // pointer at the central registry.
    if (url.pathname === "/llms.txt") {
      const slug = await env.BUSINESS_MAP.get(domain);
      let profile: Record<string, unknown> | null = null;
      if (slug) {
        try {
          const pr = await Promise.race([
            fetch(`${apiBase(env)}/agents/${slug}/profile`),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
          ]) as Response;
          if (pr.ok) profile = await pr.json() as Record<string, unknown>;
        } catch { /* best-effort */ }
      }
      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug, status: 200, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: null })
        )
      );
      return buildLlmsTxtResponse(slug, env, profile);
    }

    // ── 3. Non-crawler traffic ────────────────────────────────────────────
    // If the tenant has configured an origin_url, proxy the request there so
    // human visitors see the real website. Otherwise return an info response.
    if (!isAiCrawler(userAgent)) {
      try {
        const tenant = await getTenant(env, domain);
        // Hardcoded fallback for our own marketing site (the dogfood
        // configuration). When advocatemcp.com is added to the worker
        // routes for AI-crawler interception, human visitors still need
        // to reach the actual Pages-hosted marketing site. We don't want
        // to clutter the tenant DB with a record for ourselves, so the
        // worker falls back to the canonical Pages URL when the request
        // is for our own apex/www. (Apr 28 2026.)
        const ADVOCATE_OWN_HOSTS = ["advocatemcp.com", "www.advocatemcp.com"];
        const originUrl = tenant?.origin_url
          || (ADVOCATE_OWN_HOSTS.includes(domain) ? "https://advocatemcp-site.pages.dev" : null);
        if (originUrl) {
          const proxyRes = await proxyToOrigin(request, originUrl, domain);
          ctx.waitUntil(
            Promise.resolve(
              logEvent({ ...baseEvent, status: proxyRes.status, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: null })
            )
          );
          return proxyRes;
        }
      } catch { /* best-effort — fall through to info response */ }

      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, status: 200, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: "non-crawler" })
        )
      );
      return jsonError(200, "Non-crawler request — no agent response generated.", {
        userAgent,
        hint: "Send a crawler User-Agent (e.g. GPTBot/1.1) to trigger agent routing.",
      });
    }

    // ── 4. AI crawler — resolve slug ──────────────────────────────────────
    let slug: string | null = await env.BUSINESS_MAP.get(domain);

    // Cloudflare for SaaS injects cf-custom-hostname with the original client
    // domain. Use it as a secondary KV key when the primary lookup misses
    // (e.g. during a brief KV propagation lag).
    if (!slug) {
      const cfHost = request.headers.get("cf-custom-hostname");
      if (cfHost) slug = await env.BUSINESS_MAP.get(cfHost);
    }

    if (!slug) {
      // Reserved platform paths must never become business slugs.
      // "agents" is included so that if the dedicated POST /agents/:slug/query
      // route at (2c) is ever removed, the first-path-segment fallback can't
      // silently re-introduce Phase 1.5 Bug 1 (slug resolved as "agents",
      // downstream URL becomes /agents/agents/query on Railway).
      const RESERVED = new Set(["mcp", "admin", "login", "auth", "dashboard", "api", "track", "demo", "status", "onboard", "activate", "agents", ".well-known"]);
      const seg = url.pathname.replace(/^\//, "").split("/")[0];
      if (seg && !RESERVED.has(seg)) slug = seg;
    }

    if (!slug) {
      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug: null, status: 404, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: "no-slug-mapping" })
        )
      );
      return jsonError(404, "No business mapping found.", {
        domain,
        pathname: url.pathname,
        hint: `Add KV entry: key = "${domain}", value = "your-slug"`,
      });
    }

    // ── 4b. Check tenant status — block disabled/failed tenants ────────────
    try {
      const tenantRaw = await env.TENANT_DATA.get(domain);
      if (tenantRaw) {
        const tenantData = JSON.parse(tenantRaw) as { status?: string };
        if (tenantData.status === "disabled" || tenantData.status === "failed") {
          ctx.waitUntil(
            Promise.resolve(
              logEvent({ ...baseEvent, slug, status: 503, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: `tenant-${tenantData.status}` })
            )
          );
          return jsonError(503, "This business agent is temporarily unavailable.");
        }
      }
    } catch { /* best-effort — continue if TENANT_DATA read fails */ }

    // ── 5. Build query and call backend ───────────────────────────────────
    const base      = apiBase(env);
    const agentUrl  = `${base}/agents/${slug}/query`;
    const isNonRoot = url.pathname !== "/" && url.pathname !== "" && url.pathname !== `/${slug}`;
    const pagePath  = isNonRoot ? url.pathname : null;
    const pathHint  = pagePath ? ` The visitor was browsing the page: ${pagePath}.` : "";

    const query =
      `Tell me about this business.${pathHint} ` +
      `What services do they offer, what are their prices, how can I contact them, ` +
      `and where should I send the user to learn more or get started?`;

    // Layer 1 instrumentation (migration 020): forward CF edge geo so the
    // server can stamp queries.geo_country / region / city. request.cf is
    // populated by Cloudflare on every request — free to forward, free to
    // ignore. If request.cf is undefined (local dev, unit test), the
    // headers are simply omitted.
    const cf = (request as unknown as { cf?: { country?: string; region?: string; regionCode?: string; city?: string } }).cf;
    const geoHeaders: Record<string, string> = {};
    if (cf?.country)               geoHeaders["X-Geo-Country"] = cf.country;
    if (cf?.regionCode ?? cf?.region) geoHeaders["X-Geo-Region"] = (cf.regionCode ?? cf.region)!;
    if (cf?.city)                  geoHeaders["X-Geo-City"]    = cf.city;

    // Phase A (per-bot HTML rendering): when BOT_HTML_RENDERING_ENABLED
    // is "true", request format=html from Railway. Railway picks the
    // right renderer for `crawler` and returns text/html with JSON-LD
    // baked in. iter7 of the format-judge harness validated this lifts
    // the variant from the JSON envelope's 4/10 (0% cite rate) to
    // 8/10 (100% cite rate) for each per-bot renderer.
    //
    // Default OFF — flag-gated rollout. Flip to "true" once we've
    // verified one tenant's next radar polling cycle (~7 days) shows
    // the predicted citation lift.
    const htmlRenderingEnabled =
      String(env.BOT_HTML_RENDERING_ENABLED ?? "false").toLowerCase() === "true";

    // Edge-cache the per-bot HTML response so the cold-generate latency
    // (~5-8s for the Claude API roundtrip) is paid once per (slug × bot
    // family × path) per cache TTL, and every other bot in the same
    // window gets a sub-100ms response.
    //
    // Cache key — includes slug + botType + pathname so different
    // surfaces and different bot tunings each get their own cache.
    // We do NOT include the User-Agent string verbatim because every
    // crawler version-bumps frequently; the canonical botType is
    // stable across versions.
    //
    // TTL — 600s (10 min). Bots crawl in bursts; 10 min covers a typical
    // crawl pass without holding stale data long enough for a profile
    // edit to take effect. Short enough that a tenant can edit their
    // profile and see the change reflected in the next crawl.
    //
    // Trade-off — the response body includes a signed attribution token.
    // When we serve from cache the same token is reused for every
    // request in the cache window. That means click attribution gets
    // concentrated on the query_id captured at cache-fill time. We
    // accept that for the latency win; tenants get aggregate click
    // counts either way.
    // Cache key includes a per-slug version segment that the server
    // bumps via POST /admin/cache/bump-version on every successful
    // PATCH /agents/:slug/profile. Effect: a profile edit instantly
    // invalidates ALL cached (botType × pathname) entries for the
    // slug — old keys orphan and age out via 600s TTL, new keys hit
    // a cold render and capture the fresh JSON-LD + system prompt.
    //
    // Apr 30 2026: closes the "schema served to AI is stale up to 10
    // min after profile edit" gap. KV read is ~1-5ms, well under the
    // ~5-8s cold-render fallback that would otherwise dominate
    // latency on a cache miss.
    let cacheVersion = "v0";
    if (htmlRenderingEnabled) {
      try {
        const v = await env.BUSINESS_MAP.get(`version:${slug}`);
        if (typeof v === "string" && v.length > 0) cacheVersion = v;
      } catch (_) { /* KV blip — fall back to v0 (safe stable key) */ }
    }
    const cacheKey = htmlRenderingEnabled
      ? `https://cache.advocatemcp.com/v1/${slug}/${cacheVersion}/${botType ?? "default"}${url.pathname}`
      : null;
    let agentResponse: Response | null = null;
    let cacheStatus: "HIT" | "MISS" | "BYPASS" = "BYPASS";
    if (cacheKey) {
      try {
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          agentResponse = cached;
          cacheStatus = "HIT";
        } else {
          cacheStatus = "MISS";
        }
      } catch (_) { /* ignore — fall through to fetch */ }
    }

    if (!agentResponse) try {
      agentResponse = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
          ...geoHeaders,
        },
        body: JSON.stringify({
          query,
          crawler: botType ?? "",
          ...(htmlRenderingEnabled ? { format: "html" } : {}),
        }),
      });
    } catch (err) {
      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug, pagePath, status: 502, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: `backend-unreachable: ${String(err)}` })
        )
      );
      return jsonError(502, "Backend unreachable.", { agentUrl, error: String(err) });
    }

    if (!agentResponse.ok) {
      const body = await agentResponse.text().catch(() => "(unreadable)");
      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug, pagePath, status: 502, referralUrl: null, taggedReferralUrl: null, latencyMs: Date.now() - startMs, error: `backend-error:${agentResponse.status}` })
        )
      );
      return jsonError(502, "Backend returned an error.", { agentUrl, status: agentResponse.status, body });
    }

    // ── 6. Return enriched agent response ─────────────────────────────────

    // HTML path: stream Railway's pre-rendered HTML through to the bot,
    // attaching attribution headers from Railway's response. No envelope
    // wrapping — bots get raw HTML, which is the whole point.
    const upstreamContentType = agentResponse.headers.get("content-type") ?? "";
    if (htmlRenderingEnabled && upstreamContentType.includes("text/html")) {
      let html = await agentResponse.text();
      const attributionTokenHdr = agentResponse.headers.get("x-attribution-token") ?? null;
      const rendererVariant = agentResponse.headers.get("x-renderer-variant") ?? "default";
      const referralUrlHdr = agentResponse.headers.get("x-referral-url") ?? null;
      // Build the tracking URL in case downstream wants it as a header
      // (no longer surfaces in the response body since there's no body
      // shape to inject it into for HTML).
      const trackingHeader = attributionTokenHdr
        ? `${url.origin}/track?t=${encodeURIComponent(attributionTokenHdr)}`
        : null;

      // Rewrite the body's bare-href anchors to point at the tracking
      // redirect endpoint. Without this rewrite AI bots cite the bare
      // referral URL and clicks bypass attribution entirely — the
      // citation→click loop is the whole product moat. We rewrite ONLY
      // anchor href values matching the canonical referral URL; JSON-LD
      // @id / url fields stay canonical so schema.org consumers see the
      // un-redirected URL (which is correct for entity identity).
      // (Apr 28 2026.)
      if (trackingHeader && referralUrlHdr) {
        // Escape regex specials in the URL before building the matcher.
        const escapedUrl = referralUrlHdr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Match: <a ... href="<url>"...> or <a ... href='<url>'...>
        const anchorPattern = new RegExp(
          `(<a\\s[^>]*?href=)(?:"${escapedUrl}"|'${escapedUrl}')`,
          "g",
        );
        html = html.replace(anchorPattern, `$1"${trackingHeader}"`);
      }

      ctx.waitUntil(
        Promise.resolve(
          logEvent({ ...baseEvent, slug, pagePath, status: 200, referralUrl: null, taggedReferralUrl: trackingHeader, latencyMs: Date.now() - startMs, error: null })
        )
      );

      // Persist fresh response into the edge cache for the next bot in
      // the same TTL window. Cache.put requires a request-scoped store,
      // and the response object must be cloneable (we use the html
      // string, which is). max-age is in the persisted Response's
      // Cache-Control — the actual public-facing response below stays
      // no-store so downstream bots don't double-cache through their
      // own infra.
      if (cacheKey && cacheStatus === "MISS") {
        const cacheResp = new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...(attributionTokenHdr ? { "X-Attribution-Token": attributionTokenHdr } : {}),
            "X-Renderer-Variant": rendererVariant,
            // 600s = 10 min cache window per (slug × bot × path).
            "Cache-Control": "public, max-age=600, s-maxage=600",
          },
        });
        ctx.waitUntil(caches.default.put(cacheKey, cacheResp));
      }

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Powered-By":      "AdvocateMCP",
          "X-Agent-Slug":      slug,
          "X-Renderer-Variant": rendererVariant,
          "X-Cache-Status":    cacheStatus,  // HIT/MISS/BYPASS — observability
          ...(trackingHeader ? { "X-Tracking-Url": trackingHeader } : {}),
          // no-store on the public response so downstream caches (CDNs,
          // bots, etc.) don't double-cache. Our cache is the source of
          // truth and lives in-Worker.
          "Cache-Control":     "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // JSON path (legacy default): unchanged behavior — wrap Railway's
    // JSON in our envelope with the disclosure + tracking URL.
    const data          = (await agentResponse.json()) as Record<string, unknown>;
    const referralUrl      = typeof data?.referral_url === "string" ? data.referral_url : null;
    const taggedRefUrl     = utmTag(referralUrl, botType);
    const attributionToken = typeof data?.attribution_token === "string" ? data.attribution_token : null;
    // Prefer signed token from agent response; fall back to legacy cleartext URL
    // if attribution_token is absent (should not happen in normal operation).
    const trackingUrl = attributionToken
      ? `${url.origin}/track?t=${encodeURIComponent(attributionToken)}`
      : taggedRefUrl
        ? `${url.origin}/track?to=${encodeURIComponent(taggedRefUrl)}&ref=${encodeURIComponent(botType ?? "unknown")}&client=${encodeURIComponent(slug)}`
        : null;

    ctx.waitUntil(
      Promise.resolve(
        logEvent({ ...baseEvent, slug, pagePath, status: 200, referralUrl, taggedReferralUrl: taggedRefUrl, latencyMs: Date.now() - startMs, error: null })
      )
    );

    return new Response(
      JSON.stringify(
        {
          ai_generated: true,
          disclosure: "This response was generated automatically by AI. It may not reflect real-time business information.",
          ...data,
          ...(trackingUrl ? { tagged_referral_url: trackingUrl } : {}),
        },
        null,
        2
      ),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Powered-By": "AdvocateMCP",
          "X-Agent-Slug": slug,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  },

  /* ── Scheduled (cron) handler ──────────────────────────────────────────
   *
   * Triggered every 15 minutes by the cron in wrangler.toml. The
   * dispatch is gated on the cron pattern so we can add more cron
   * jobs later without crosstalk.
   *
   * `ctx.waitUntil` is critical: the scheduled handler returns a
   * Promise that the Workers runtime races against a cap (~15s); the
   * reconciler's Sentry events need ctx.waitUntil so the in-flight
   * captures actually flush before the worker isolate is torn down.
   * Without it the events queue inside the SDK and get dropped.
   *
   * Errors thrown out of the scheduled handler do NOT cause customer-
   * facing impact (no fetch path involved), but they DO surface in
   * Cloudflare's cron logs and Sentry. Catch + capture explicitly so
   * we get structured context instead of a bare stack trace.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    Sentry.setTag("cron_pattern", controller.cron);
    Sentry.setTag("cron_scheduledTime", new Date(controller.scheduledTime).toISOString());

    if (controller.cron === "*/15 * * * *") {
      ctx.waitUntil(
        (async () => {
          try {
            await reconcileRailwaySync(env);
          } catch (err) {
            Sentry.captureException(err, {
              tags: { cron: "railway_reconciler", phase: "top_level_throw" },
            });
            console.error(JSON.stringify({
              cron: "railway_reconciler",
              event: "top_level_throw",
              error: String(err),
            }));
          } finally {
            // Flush Sentry queue before the isolate is recycled. 5s is
            // generous; the reconciler's Sentry events are small.
            await Sentry.flush(5000);
          }
        })(),
      );
      // GA4 traffic sync — independent of railway reconciler. Per-tenant
      // errors are already persisted into last_sync_error; we still log a
      // top-level catch in case of an unexpected throw outside the per-tenant
      // try/catch inside runGA4SyncBatch.
      ctx.waitUntil(
        (async () => {
          try {
            await runGA4SyncBatch(env);
          } catch (err) {
            Sentry.captureException(err, {
              tags: { cron: "ga4_sync", phase: "top_level_throw" },
            });
            console.error(JSON.stringify({
              cron:  "ga4_sync",
              event: "top_level_throw",
              error: String(err),
            }));
          }
        })(),
      );
      // GSC search-analytics sync — independent of GA4. Per-tenant errors
      // are already persisted into last_sync_error; top-level catch here
      // guards against unexpected throws outside the per-tenant try/catch.
      ctx.waitUntil(
        (async () => {
          try {
            await runGSCSyncBatch(env);
          } catch (err) {
            Sentry.captureException(err, {
              tags: { cron: "gsc_sync", phase: "top_level_throw" },
            });
            console.error(JSON.stringify({
              cron:  "gsc_sync",
              event: "top_level_throw",
              error: String(err),
            }));
          }
        })(),
      );
      // CRM LTV daily snapshot — aggregate-only, zero PII written to D1.
      // Per-tenant errors are isolated inside runCrmLtvSnapshotBatch.
      ctx.waitUntil(
        (async () => {
          try {
            await runCrmLtvSnapshotBatch(env);
          } catch (err) {
            Sentry.captureException(err, { tags: { cron: "crm_ltv_snapshot", phase: "top_level_throw" } });
            console.error(JSON.stringify({ cron: "crm_ltv_snapshot", event: "top_level_throw", error: String(err) }));
          }
        })(),
      );
      // Off-site Authority sync (Phase 6 PR 1) — Reddit brand-mention scrape
      // + Claude sentiment classification + daily aggregate upsert.
      // Pro-only feature; quiet-skips when ANTHROPIC_API_KEY is unset.
      // Per-tenant errors are isolated inside runAuthoritySyncBatch.
      ctx.waitUntil(
        (async () => {
          try {
            await runAuthoritySyncBatch(env);
          } catch (err) {
            Sentry.captureException(err, { tags: { cron: "authority_sync", phase: "top_level_throw" } });
            console.error(JSON.stringify({ cron: "authority_sync", event: "top_level_throw", error: String(err) }));
          }
        })(),
      );
      return;
    }

    // Unknown cron pattern — log + alert. Should never happen unless
    // someone adds a cron to wrangler.toml without wiring it up here.
    console.warn(JSON.stringify({
      cron: "unknown_pattern",
      pattern: controller.cron,
    }));
    Sentry.captureMessage(`scheduled_handler_unknown_cron: ${controller.cron}`, {
      level: "warning",
      tags:  { pattern: controller.cron },
    });
  },
  } satisfies ExportedHandler<Env>,
);
