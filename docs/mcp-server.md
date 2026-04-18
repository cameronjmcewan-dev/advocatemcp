# MCP Server

## What exists today

The central MCP server lives at `POST /mcp` and `GET /mcp` on the Railway Express backend (`server/src/routes/mcp.ts`). It uses `@modelcontextprotocol/sdk` with the `StreamableHTTPServerTransport` (stateless mode — a new `McpServer` instance is created per request to avoid shared-transport concurrency issues). The Worker proxies all `/mcp` and `/mcp/*` paths straight through to Railway without modification, so the MCP endpoint is accessible at both the Railway URL and the Worker's public hostname.

## Tools exposed

**`query_business_agent`** — accepts `{ slug: string, query: string }`. Looks up the business in SQLite, calls `queryAgent()` (same code path as the crawler flow), and returns the Claude response as a JSON text block. Returns an `isError: true` result if the slug is not found.

**`search_businesses`** — accepts `{ search: string, location?: string }`. Runs a LIKE search across `name`, `description`, `services`, and `category` in the SQLite `businesses` table (with optional `location` filter). Returns up to 20 matches with slug, name, description, category, location, website, star_rating, review_count, pricing_tier, and an `agent_endpoint` URL. Returns a descriptive "no results" string if nothing matches.

## Transports

- `POST /mcp` — Streamable HTTP (primary). Compatible with Claude Desktop, Cursor, and any spec-compliant MCP client. Add `{ "url": "https://api.advocatemcp.com/mcp", "transport": "http" }` to MCP client config.
- `GET /mcp` with `Accept: text/event-stream` — SSE handshake (older transport). Handled by the same `StreamableHTTPServerTransport`.
- `GET /mcp` without SSE header — returns a human-readable JSON info page listing the tools and connect instructions.

## Discovery

`/.well-known/ai-agent.json` is served by the Worker on every business domain. It includes `mcp_endpoint` pointing to Railway `/mcp`. This is the discovery surface for AI tools that check for agent endpoints before scraping.

## Session 3 — directory-submission hardening

**Shipped 2026-04-18.**

- **Manifest endpoint** — `/.well-known/mcp.json` (Session 8). Directories that crawl capability manifests get tool schemas, transport, rate limits, auth modes, and the attribution endpoint from a single GET.
- **Per-IP rate limit** — sliding 60-request-per-minute window keyed on `cf-connecting-ip`.
  - **Primary:** `worker/src/lib/mcpRateLimitDO.ts` (`McpRateLimiterDO` Durable Object). A single global DO instance (id `mcp-rate-limiter-v1`) coordinates counters across every CF edge so the per-IP cap is globally coherent.
  - **Fallback:** `worker/src/lib/mcpRateLimit.ts` (in-memory per CF isolate). Kicks in when the DO is unreachable (outage, rollout, missing binding). Imperfect — multi-edge traffic during a DO outage could multiply an attacker's effective limit — but it beats zero enforcement.
  - Exceeded requests return `429 { error: "rate_limited", retry_after_seconds }` with `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining` response headers.
- **Structured logging** — every `/mcp` proxy emits one JSON line: `{ metric: "mcp_proxy", path, method, status, latency_ms, remaining, source }` where `source` is `"do"` (DO-backed) or `"isolate_fallback"` (DO miss). Rate-limited requests log as `mcp_rate_limited`; DO outages log as `mcp_rate_limit_do_unreachable`; proxy errors as `mcp_proxy_error`. Queryable via Cloudflare observability.
- **Railway-side tool logging** — still provided by `agent_requests` (Session 11). `withAgentRequestLog` wraps every tool invocation with latency, outcome, and agent attribution.

### Tuning the rate limit

Defaults live in `worker/src/lib/mcpRateLimit.ts` (used by both the DO and the in-memory fallback):

- `DEFAULT_LIMIT = 60` requests
- `DEFAULT_WINDOW_MS = 60_000` — 60 seconds
- `DEFAULT_MAX_IPS = 10_000` — LRU cap on tracked clients

To raise or lower, edit the constants and redeploy the Worker. A true runtime knob (env var or wrangler.toml `[vars]`) is a follow-up once a real abuse signal argues for it.

### First-time DO deploy

The DO is registered via the `[[migrations]]` stanza in `wrangler.toml` (`tag = "v1-mcp-rate-limiter"`, `new_classes = ["McpRateLimiterDO"]`). The first `wrangler deploy` after this lands creates the DO class on Cloudflare; subsequent deploys reuse it. If additional DO classes are added later, append a new `[[migrations]]` stanza with a monotonically-increasing tag — do not mutate the existing one.

### Submitting to directories

With the hardening above, the `/mcp` endpoint at `https://api.advocatemcp.com/mcp` is ready for submission to:

- **Smithery** — `https://smithery.ai/` — submit via their web form
- **PulseMCP** — `https://pulsemcp.com/` — submit via their web form
- **Anthropic MCP registry** — `https://github.com/modelcontextprotocol/servers` — PR to the community-maintained list

Each submission should reference the manifest at `/.well-known/mcp.json`, the tools listed above, and the rate-limit posture (60 req/min per IP).

## Updating this doc

Update this file at the end of any session that touches `server/src/routes/mcp.ts`, `worker/src/lib/mcpRateLimit.ts`, or the `/mcp` proxy in `worker/src/index.ts`.
