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

## What is not yet built

Session 3 will harden the MCP server for public directory submission: manifest endpoint, per-IP rate limiting via Durable Object, structured logging, and alignment with the latest MCP spec. The current implementation is functional but not submission-ready.

## Updating this doc

Update this file at the end of any session that touches `server/src/routes/mcp.ts` or the `/mcp` proxy in `worker/src/index.ts`.
