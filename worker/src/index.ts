/**
 * AdvocateMCP Cloudflare Worker
 *
 * Intercepts requests from AI search crawlers and routes them to the
 * appropriate business's AdvocateMCP agent instead of the raw HTML page.
 *
 * All other traffic is passed through to the origin unchanged.
 */

export interface Env {
  /** KV namespace: maps domain → business slug
   *  e.g. "joes-pizza.com" → "joes-pizza-austin"
   */
  BUSINESS_MAP: KVNamespace;
  /** API key accepted by the AdvocateMCP server (set via `wrangler secret put API_KEY`) */
  API_KEY: string;
  /** Override the API base URL (defaults to https://api.advocatemcp.com) */
  API_BASE_URL?: string;
}

// ── Known AI crawler User-Agent substrings ─────────────────────────────────
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

function isAiCrawler(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return AI_CRAWLERS.some((bot) => ua.includes(bot.toLowerCase()));
}

function apiBase(env: Env): string {
  return env.API_BASE_URL ?? "https://api.advocatemcp.com";
}

// ── Well-known ai-agent.json response ─────────────────────────────────────
function buildWellKnownResponse(slug: string | null, env: Env): Response {
  const base = apiBase(env);
  const spec = {
    spec_version: "1.0",
    agent_endpoint: slug
      ? `${base}/agents/${slug}/query`
      : `${base}/agents/{slug}/query`,
    mcp_endpoint: `${base}/mcp`,
    protocol: "advocatemcp-v1",
    capabilities: ["answer_queries", "referral", "availability"],
    crawler_instructions: slug
      ? `POST to agent_endpoint with JSON body { "query": string } instead of scraping this page. ` +
        `This site (${slug}) is powered by AdvocateMCP.`
      : `POST to agent_endpoint (fill in the slug) with JSON body { "query": string } instead of scraping HTML.`,
    powered_by: "AdvocateMCP",
  };

  return new Response(JSON.stringify(spec, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ── Main fetch handler ────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const domain = url.hostname;
    const userAgent = request.headers.get("User-Agent") ?? "";

    // ── 1. Always serve /.well-known/ai-agent.json for AI discoverability ──
    if (url.pathname === "/.well-known/ai-agent.json") {
      const slug = await env.BUSINESS_MAP.get(domain);
      return buildWellKnownResponse(slug, env);
    }

    // ── 2. Passthrough for non-AI traffic ──────────────────────────────────
    if (!isAiCrawler(userAgent)) {
      return fetch(request);
    }

    // ── 3. AI crawler detected — look up the business slug ────────────────
    const slug = await env.BUSINESS_MAP.get(domain);

    if (!slug) {
      // No mapping for this domain — fall through to origin
      return fetch(request);
    }

    const base = apiBase(env);
    const agentUrl = `${base}/agents/${slug}/query`;

    // Build a contextual query from the URL path so the agent can give
    // page-specific answers (e.g. pricing page vs. about page).
    const pathHint =
      url.pathname !== "/" && url.pathname !== ""
        ? ` (the visitor is on the page: ${url.pathname})`
        : "";

    const query =
      `Tell me about this business${pathHint}. ` +
      `What services do they offer, what are their prices, how can I contact them, ` +
      `and where should I send the user to learn more or get started?`;

    // ── 4. Call the AdvocateMCP agent ─────────────────────────────────────
    let agentResponse: Response;
    try {
      agentResponse = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": env.API_KEY,
        },
        body: JSON.stringify({ query, crawler: userAgent }),
      });
    } catch {
      // Network error — fail silently and serve the real page
      return fetch(request);
    }

    if (!agentResponse.ok) {
      // Agent returned an error — serve the real page instead
      return fetch(request);
    }

    const data = (await agentResponse.json()) as unknown;

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "X-Powered-By": "AdvocateMCP",
        "X-Agent-Slug": slug,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
