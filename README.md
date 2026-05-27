<div align="center">

<img src="https://advocatemcp.com/icon-192.png" width="96" alt="AdvocateMCP" />

# AdvocateMCP

**The MCP layer for local businesses.**

Discover, query, book, and transact with verified SMB AI agents through any MCP-compatible client — Claude Desktop, Claude.ai, Cursor, ChatGPT, or your own.

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-active-success?style=flat-square)](https://registry.modelcontextprotocol.io/v0/servers?search=com.advocatemcp/advocate)
[![Smithery](https://img.shields.io/badge/Smithery-listed-blue?style=flat-square)](https://smithery.ai/servers/cameronjmcewan/advocate-mcp)
[![Anthropic](https://img.shields.io/badge/Anthropic_Connectors-pending-yellow?style=flat-square)](https://claude.com/docs/connectors/building/submission)
[![Status](https://img.shields.io/badge/status-production-brightgreen?style=flat-square)](https://api.advocatemcp.com/.well-known/mcp.json)
[![SafeSkill 20/100](https://img.shields.io/badge/SafeSkill-20%2F100_Blocked-red)](https://safeskill.dev/scan/cameronjmcewan-dev-advocatemcp)

[Spec](https://advocatemcp.com/mcp.html) ·
[Manifest](https://api.advocatemcp.com/.well-known/mcp.json) ·
[Privacy](https://advocatemcp.com/privacy) ·
[Terms](https://advocatemcp.com/terms)

</div>

## What it does

AdvocateMCP turns every local business into an AI-ready agent. One MCP endpoint, ten tools:

**Discovery (open, no auth):**

- `search_businesses` — search by category, name, or location
- `query_business_agent` — ask a specific business's AI agent for citation-ready answers
- `get_availability` — 30-min slot windows derived from business hours
- `get_quote` — exact / range / estimate-labelled pricing
- `get_credentials` — self-reported licenses, insurance, bonding, certifications
- `get_cancellation_policy` — verbatim cancellation/refund/no-show policy

**Transactional (per-tenant Bearer; agent-to-agent):**

- `reserve_slot` — 15-min HELD reservation, returns signed confirmation token
- `initiate_handoff` — SMS/email a human or mint a signed continuation URL for another agent
- `request_callback` — push user contact to the business with idempotency key
- `subscribe_to_updates` — double-opt-in email subscription (CAN-SPAM/GDPR)

All ten carry MCP-spec annotations: `title`, `readOnlyHint`, `destructiveHint`, `openWorldHint`. Every outbound link is HMAC-SHA256-signed for end-to-end attribution.

## Quick start (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "advocate": {
      "url": "https://api.advocatemcp.com/mcp",
      "transport": "http"
    }
  }
}
```

Restart Claude Desktop. Try:

- *"Find me a marketing agency in Austin"*
- *"What does the top-rated email-marketing agency in my area charge for a 4-email welcome sequence?"*
- *"When is a law firm with 5-star reviews available Thursday afternoon?"*
- *"Is the locksmith on 5th Avenue licensed and insured?"*

## How it works (also a bot interceptor)

Beyond the central MCP server, AdvocateMCP runs at the edge on each registered business's domain. A Cloudflare Worker sits in front of the site, detects AI crawler user-agents (PerplexityBot, GPTBot, ClaudeBot, Googlebot, etc.), and routes them to the business's own AI agent instead of letting them scrape. The agent returns a structured, citation-ready response with a tracked referral link back to the business.

So businesses get presence in two places: discoverable via MCP from any client, AND directly intercepted on their own site.

## Architecture

- **Edge:** Cloudflare Worker (TypeScript, strict mode) deployed via wrangler — `customers.advocatemcp.com`
- **Backend:** Node.js + Express on Railway — `api.advocatemcp.com`
- **Databases:** SQLite for analytics + business data; Cloudflare D1 for portal auth + edge data; KV namespace `BUSINESS_MAP` for domain → slug routing
- **AI:** Anthropic Claude (`claude-sonnet-4-6`), prompt caching enabled
- **Transport:** Streamable HTTP (JSON-RPC 2.0); SSE retained for backward-compat but not advertised
- **Rate limiting:** 60 req/min per IP via Cloudflare Durable Object; per-agent tier ceilings (unverified=100, known=250, trusted=1000)

## Repository layout

```
advocatemcp/
├── server/        Node/Express backend (Railway) — /mcp endpoint, agent query, analytics
├── worker/        Cloudflare Worker — bot detection, multi-tenant portal, edge bot routing
├── site/          Cloudflare Pages — marketing site, dashboard, public spec
├── docs/          Subsystem docs (read before touching that subsystem)
└── CLAUDE.md      Agent instructions for working in this repo
```

## Documentation

- [Spec](https://advocatemcp.com/mcp.html) — public MCP spec page
- [Bot detection](docs/bot-detection.md) — which crawlers we route
- [Attribution](docs/attribution.md) — signed-token referral tracking
- [Response generation](docs/response-generation.md) — per-bot prompt tuning
- [MCP server](docs/mcp-server.md) — endpoint architecture

## Status

- ✅ Production traffic since 2026-04-18
- ✅ Listed on the official [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=com.advocatemcp/advocate)
- ✅ Listed on [Smithery](https://smithery.ai/servers/cameronjmcewan/advocate-mcp)
- ✅ Auto-ingested by [PulseMCP](https://www.pulsemcp.com) (~7 day delay)
- ⏳ Submitted to Anthropic Connectors Directory (review pending)

## License

Proprietary (hosted SaaS). The MCP manifest spec is open — see `/.well-known/mcp.json` for the schema.

## Contact

[max@advocate-mcp.com](mailto:max@advocate-mcp.com)
