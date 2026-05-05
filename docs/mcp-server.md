# MCP Server

## What exists today

The central MCP server lives at `POST /mcp` and `GET /mcp` on the Railway Express backend (`server/src/routes/mcp.ts`). It uses `@modelcontextprotocol/sdk` with the `StreamableHTTPServerTransport` (stateless mode — a new `McpServer` instance is created per request to avoid shared-transport concurrency issues). The Worker proxies all `/mcp` and `/mcp/*` paths straight through to Railway without modification, so the MCP endpoint is accessible at both the Railway URL and the Worker's public hostname.

## Tools exposed (10, as of Apr 30 2026 Phase 1 expansion)

All tools are registered via [server/src/routes/mcp.ts](../server/src/routes/mcp.ts) and described in [server/src/manifest/descriptor.ts](../server/src/manifest/descriptor.ts). Every tool carries MCP-spec annotations (`title`, `readOnlyHint`, `destructiveHint`, `openWorldHint`) — `title` is required by Anthropic's Connectors Directory submission and absence accounts for ~30% of directory rejections.

### Discovery (open, no auth)

**`query_business_agent`** — `{ slug, query, agent_id?, stage? }`. Looks up the business in SQLite, calls `queryAgent()` (same code path as the crawler flow), returns the Claude response as JSON text. `isError: true` on slug miss.

**`search_businesses`** — `{ search, location? }`. LIKE search across `name`, `description`, `services`, `category` in the `businesses` table. Returns up to 20 matches with slug, agent endpoint, and metadata.

**`get_availability`** — `{ slug, window_start?, window_end? }`. 30-min slot windows derived from `hours_json` (v1 synthetic). `availability_webhook_url` column reserved for v2.

**`get_quote`** — `{ slug, service, params? }`. Deterministic from `pricing_json_v2.ranges[]` first, Claude fallback labeled `"estimate"`.

**`get_credentials`** — `{ slug }`. Self-reported licenses, insurance, bonding, certifications. Trust-sensitive verticals (contractors, healthcare, legal). Framed as "self-reported" so agents don't upgrade tenant claims to verified facts.

**`get_cancellation_policy`** — `{ slug }`. Verbatim cancellation/refund/no-show policy. When missing, returns guidance for the agent to acknowledge the gap.

### Transactional (per-tenant Bearer required — agent-to-agent surface)

**`reserve_slot`** — `{ slug, window_start, window_end, customer_contact, idempotency_key }`. Creates a 15-min HELD reservation, returns signed `confirmation_token`. Idempotency_key UNIQUE catch for race-safety.

**`initiate_handoff`** — `{ slug, mode: "human" | "agent", payload }`. Discriminated union: `human` notifies via `lead_routing_json` recipient through Twilio (or short-circuits with `no_recipient_configured`); `agent` mints signed continuation URL.

**`request_callback`** — `{ slug, contact, preferred_channel?, reason?, urgency?, agent_id?, idempotency_key }`. Pushes user contact to business. Idempotent on idempotency_key within 24h.

**`subscribe_to_updates`** — `{ slug, contact_email, topics[], agent_id? }`. Double-opt-in email subscription (CAN-SPAM/GDPR). Returns confirmation_url; user must click within 7 days.

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

With the hardening above plus the `title` annotation added 2026-05-04, the `/mcp` endpoint at `https://api.advocatemcp.com/mcp` is ready for submission to:

- **MCP Registry** (official, vendor-neutral) — `https://registry.modelcontextprotocol.io/` — self-serve CLI publish via `make publisher` from `modelcontextprotocol/registry`. Reverse-DNS namespace (`com.advocatemcp/advocate-mcp`). No manual review queue.
- **Anthropic Connectors Directory** (Claude.ai-curated) — `https://clau.de/mcp-directory-submission` — Google Form, ~2 week manual review. Requires `title` annotation, privacy policy URL, 3–5 promotional screenshots ≥1000px.
- **Smithery** — `https://smithery.ai/` — submit via their web form, 3–7 day turnaround.
- **PulseMCP** — `https://pulsemcp.com/` — submit via their web form.

Each submission should reference the manifest at `/.well-known/mcp.json`, the 10 tools listed above, and the rate-limit posture (60 req/min per IP). See [docs/mcp-directory-submissions.md](mcp-directory-submissions.md) for pre-filled per-directory form answers.

## Updating this doc

Update this file at the end of any session that touches `server/src/routes/mcp.ts`, `worker/src/lib/mcpRateLimit.ts`, or the `/mcp` proxy in `worker/src/index.ts`.
