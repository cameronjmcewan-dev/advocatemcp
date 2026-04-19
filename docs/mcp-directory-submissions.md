# MCP Directory Submissions — Pre-filled Answers

Copy-paste targets for submitting AdvocateMCP to each of the major MCP
directories. One section per directory with the exact fields they ask for.

Submit in this order: **Smithery → PulseMCP → Anthropic's registry**.
Each later submission benefits from showing the earlier listings as proof of
ecosystem presence.

Last validated: 2026-04-19.

---

## Shared details (reused in every submission)

| Field | Value |
|---|---|
| **Project name** | AdvocateMCP |
| **Display name** | Advocate |
| **Endpoint URL** | `https://api.advocatemcp.com/mcp` |
| **Transport** | Streamable HTTP (JSON-RPC 2.0 + SSE) |
| **Public spec page** | `https://advocatemcp.com/mcp.html` |
| **Manifest URL** | `https://api.advocatemcp.com/.well-known/mcp.json` |
| **Category** | Local business / SMB directory / Customer discovery |
| **License** | Proprietary (hosted SaaS); SDK/manifest spec is open |
| **Maintainer email** | support@advocatemcp.com |
| **Repository** | `https://github.com/cameronjmcewan-dev/advocatemcp` |
| **Logo** | `https://advocatemcp.com/icon-512.png` (512×512 PNG) |

### Short description (≤ 140 chars)

> Search and query a directory of local businesses' AI-ready advocate agents. Platform-neutral, zero setup per AI assistant.

### Medium description (≤ 500 chars)

> AdvocateMCP is the MCP layer for local businesses. Any AI assistant connects once and gains real-time access to verified business profiles, booking slots, price quotes, and agent handoffs. Each business publishes one canonical profile (hours, services, credentials, lead-routing preferences); Advocate turns that into a citation-ready agent that answers on behalf of the business across every AI surface. Attribution is signed and tracked end-to-end.

### Long description (copy the landing page for anything ≥ 500 chars)

See `site/mcp.html` — the live version on `advocatemcp.com/mcp.html` is the
canonical long-form description.

### Example queries (for "how is this used?" fields)

1. "Find me a plumber in Boise who handles 24/7 emergencies."
2. "What does Workman Copy Co charge for a 4-email welcome sequence?"
3. "Book a 30-minute consultation with Apex Legal on Thursday afternoon."
4. "What's the best-rated DTC email agency in Austin?"

### Tools list (for forms that ask enumerate tools)

- `search_businesses` — search by category, name, or location
- `query_business_agent` — query a specific business's agent
- `get_availability` — 30-min slot windows from `hours_json`
- `get_quote` — price quote from `pricing_json_v2`
- `reserve_slot` — 15-min HELD reservation with signed confirmation token
- `initiate_handoff` — SMS/email to a human or signed URL to another agent

---

## 1. Smithery ([smithery.ai](https://smithery.ai))

**Submission path:** smithery.ai/submit → "New MCP server"

| Field | Answer |
|---|---|
| Name | `AdvocateMCP` |
| Slug | `advocate-mcp` |
| Description (short) | See "Short description" above |
| Endpoint | `https://api.advocatemcp.com/mcp` |
| Transport | Streamable HTTP |
| Tags | `local-business`, `directory`, `smb`, `lead-gen`, `attribution` |
| Auth required | Discovery: none. Transactions: per-tenant Bearer. |
| Homepage | `https://advocatemcp.com/mcp.html` |
| GitHub | `https://github.com/cameronjmcewan-dev/advocatemcp` |
| Contact | support@advocatemcp.com |
| Example queries | See list above |

**Review expectation:** 3–7 day turnaround. Reviewer may ping to
confirm uptime — the server is always-on, so hit `GET /mcp` and they'll see
the initialize handshake.

---

## 2. PulseMCP ([pulsemcp.com](https://www.pulsemcp.com))

**Submission path:** pulsemcp.com/submit

PulseMCP's form asks for many of the same fields as Smithery, plus:

| Field | Answer |
|---|---|
| Server type | Remote (Streamable HTTP), not a local binary |
| Deployment | Hosted by maintainer on Cloudflare + Railway |
| Pricing | Free to connect; per-business subscription model (not per-API-call) |
| Rate limits | 60 RPM per IP for discovery; 10 RPM for transactional tools |
| Stability claim | Production |
| Changelog URL | `https://github.com/cameronjmcewan-dev/advocatemcp/releases` (once we start tagging) |

**Notable extras:** PulseMCP encourages a YouTube or demo link. Record a
90-second screen-cap of Claude Desktop using the server to find WCC and
run a query; link it in the submission. Skip if no recording yet — the
listing will still be accepted, just without a demo banner.

---

## 3. Anthropic MCP Registry

**Submission path:** likely via `github.com/anthropics/mcp-registry` PR (registry
format is still evolving — check their README for the current process at
submission time).

The registry entry is a YAML/JSON manifest with fields close to what
`/.well-known/mcp.json` already emits. Expected shape (pseudocode):

```yaml
name: advocate-mcp
display_name: AdvocateMCP
description: |
  The MCP layer for local businesses...
url: https://api.advocatemcp.com/mcp
homepage: https://advocatemcp.com/mcp.html
maintainer: Cameron McEwan <support@advocatemcp.com>
transport: streamable-http
category: local-business
tools:
  - search_businesses
  - query_business_agent
  - get_availability
  - get_quote
  - reserve_slot
  - initiate_handoff
```

**Expect back-and-forth.** Anthropic reviewers will likely ask about:
(a) rate limits and abuse protection — answer: Cloudflare Durable Object
per-IP limits; (b) handling of PII in tool outputs — answer: we never
surface customer contact info through MCP responses, only the business
side of a conversation; (c) attribution — worth volunteering proactively.

---

## Post-submission checklist

After each directory goes live:

1. Update `site/js/dashboard-surfaces.js` — change that directory's status
   badge from "Submission in progress" to "Live (listed X date)".
2. Add a backlink from `site/mcp.html` into the "On these directories"
   list (todo: add that section when the first listing lands).
3. Note the listing URL in `docs/followups.md` so future operator work
   knows where to check status.
4. Add a row to the AdvocateMCP GitHub README directory listings table.

## If a submission is rejected

Most common reasons + responses:

- **"Endpoint requires auth"** → re-emphasize that discovery tools
  (`search_businesses`, `query_business_agent`) are fully open. Only
  write-path tools require a per-tenant Bearer — which the directory
  reviewer doesn't need to test.
- **"Rate limits not documented"** → point them at `mcp.html` Rate
  Limits section + `/.well-known/mcp.json` which declares the limits
  machine-readably.
- **"No clear use case"** → send them the demo video OR run a live
  one-on-one via Zoom demonstrating Claude Desktop querying WCC.

## Outreach ordering rationale

Smithery has the highest throughput and fastest turnaround — get the
first listing there to prove the ecosystem bench. PulseMCP has stronger
editorial curation and will want to see at least one prior listing.
Anthropic's registry is the slowest and most selective; go last, when
the others are already live and can be cited as prior-art.
