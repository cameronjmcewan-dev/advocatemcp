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

import type { Env } from "./types";
import { handlePortal } from "./routes/portal";
import { handleDemo } from "./routes/demo";

export type { Env };

// ── AI crawler User-Agent detection ────────────────────────────────────────

const AI_CRAWLERS = [
  "PerplexityBot",
  "GPTBot",
  "OAI-SearchBot",
  "ClaudeBot",
  "Google-Extended",
  "Googlebot",
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

function apiBase(env: Env): string {
  return env.API_BASE_URL ?? "https://advocate-production-2887.up.railway.app";
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

function buildWellKnownResponse(
  slug: string | null,
  env: Env,
  profile: Record<string, unknown> | null = null
): Response {
  const base = apiBase(env);
  const body: Record<string, unknown> = {
    spec_version: "1.0",
    spec_name: "ai-agent-discovery",
    agent_endpoint: slug ? `${base}/agents/${slug}/query` : `${base}/agents/{slug}/query`,
    profile_endpoint: slug ? `${base}/agents/${slug}/profile` : null,
    mcp_endpoint: `${base}/mcp`,
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs    = Date.now();
    const url        = new URL(request.url);
    const domain     = url.hostname;
    const userAgent  = request.headers.get("User-Agent") ?? "";
    const timestamp  = new Date(startMs).toISOString();
    const botType    = crawlerName(userAgent);

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

    // ── 1c. Referral-click redirect — GET /track ─────────────────────────
    // Bot-filtered: only logs clicks from non-crawler User-Agents.
    // URL format: /track?to=<dest>&ref=<botName>&client=<slug>
    if (url.pathname === "/track" && request.method === "GET") {
      const dest   = url.searchParams.get("to");
      const ref    = url.searchParams.get("ref") ?? "unknown";
      const client = url.searchParams.get("client");
      const target = dest ?? apiBase(env);
      if (dest && client && !isAiCrawler(userAgent)) {
        // Human click — log event with IP hash for deduplication
        const ip = (
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          ""
        );
        ctx.waitUntil(
          hashIp(ip).then((ip_hash) =>
            fetch(`${apiBase(env)}/analytics/${client}/referral-click`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ref, user_agent: userAgent, ip_hash }),
            }).catch(() => { /* best-effort */ })
          )
        );
      }
      return Response.redirect(target, 302);
    }

    // ── 2. AI discovery file ──────────────────────────────────────────────
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

    // ── 3. Non-crawler traffic ────────────────────────────────────────────
    if (!isAiCrawler(userAgent)) {
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

    if (!slug) {
      const seg = url.pathname.replace(/^\//, "").split("/")[0];
      if (seg) slug = seg;
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

    let agentResponse: Response;
    try {
      agentResponse = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
        },
        body: JSON.stringify({ query, crawler: userAgent }),
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
    const data          = (await agentResponse.json()) as Record<string, unknown>;
    const referralUrl   = typeof data?.referral_url === "string" ? data.referral_url : null;
    const taggedRefUrl  = utmTag(referralUrl, botType);
    const trackingUrl   = taggedRefUrl
      ? `${url.origin}/track?to=${encodeURIComponent(taggedRefUrl)}&ref=${encodeURIComponent(botType ?? "unknown")}&client=${encodeURIComponent(slug)}`
      : null;

    ctx.waitUntil(
      Promise.resolve(
        logEvent({ ...baseEvent, slug, pagePath, status: 200, referralUrl, taggedReferralUrl: taggedRefUrl, latencyMs: Date.now() - startMs, error: null })
      )
    );

    return new Response(
      JSON.stringify(
        { ...data, ...(trackingUrl ? { tagged_referral_url: trackingUrl } : {}) },
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
};
