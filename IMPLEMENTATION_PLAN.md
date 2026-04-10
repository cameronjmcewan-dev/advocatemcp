# AdvocateMCP — Implementation Plan

Sessions must be completed in order. Session 1 is non-negotiable as first because signed tokens and query_id linkage are prerequisites for every downstream analytics feature. After each session ships, update the relevant `docs/` file and commit.

---

## Session 1 — Attribution Hardening

**Scope:** Harden the existing `/track` + `click_events` attribution system by closing four specific gaps. Do NOT rebuild what already works. The Worker `/track` wrapper, UTM tagging, `click_events` table, and `POST /analytics/:slug/referral-click` endpoint all exist and function — the skeleton is complete.

**Background:** Intent classification (six categories: brand_direct, emergency, affordable, best_top, specific_service, general) already runs on every query and is stored in `queries.intent`. Server-side click logging already fires via the Worker `/track` endpoint. Neither should be duplicated or replaced.

### Gap 1 — query_id linkage

- `queryAgent()` in `server/src/agent/query.ts` captures the `lastInsertRowid` from the queries INSERT and includes it as `query_id` in the response payload
- The Worker reads `query_id` from the agent response and encodes it in the tracking token (see Gap 3)
- The `referral-click` handler uses it to `UPDATE queries SET referral_clicked = 1 WHERE id = ?` in the same transaction as the `click_events` INSERT

### Gap 2 — destination on click_events

- New SQLite migration adds `destination TEXT` column to `click_events`
- The `/track` handler passes the `dest` value through to `POST /analytics/:slug/referral-click`
- The `referral-click` handler stores it. Old rows have `NULL` destination — backwards compatible

### Gap 3 — signed tokens

- Replace cleartext `/track?to=X&ref=Y&client=Z` with `/track?t=<signed-token>`
- Token payload: `{ dest, ref, slug, qid, iat }` — base64url-encoded JSON
- Token = `base64url(payload) + "." + base64url(HMAC-SHA256(payload, TOKEN_SIGNING_KEY))`
- Token generation: `server/src/lib/tracked-url.ts` (called by agent route when building response)
- Token verification: `worker/src/lib/tracked-url.ts` (called by `/track` handler before trusting any field)
- Signing logic must be identical in both files — if they diverge, all tokens break
- `TOKEN_SIGNING_KEY` added as both a Wrangler secret and a Railway env var with identical values
- Tokens older than 90 days are rejected at verification time
- Fallback: if `/track` receives the old cleartext query-string format, process it but set `legacy = 1` in `click_events` (new column, default 0). Monitor legacy decay; remove fallback once traffic drops to zero

### Gap 4 — referral_clicked update

- Covered by Gap 1 above — no separate work item

### New database migrations required

- SQLite (Railway): `ALTER TABLE click_events ADD COLUMN destination TEXT` and `ALTER TABLE click_events ADD COLUMN query_id INTEGER` and `ALTER TABLE click_events ADD COLUMN legacy INTEGER DEFAULT 0`
- No D1 migration required for Session 1

### New env vars required

- `TOKEN_SIGNING_KEY` — Wrangler secret (set from `worker/` directory) + Railway env var (identical value)

### Files to create

- `server/src/lib/tracked-url.ts` — token generation (sign + encode)
- `worker/src/lib/tracked-url.ts` — token verification (decode + verify HMAC + check expiry)

### Files to modify

- `server/src/agent/query.ts` — return `query_id` in result
- `server/src/routes/agent.ts` — pass `query_id` from `queryAgent` result into token, return signed URL
- `server/src/routes/analytics.ts` — `referral-click` handler: accept `destination`, `query_id`, `legacy`; update `queries.referral_clicked`; insert into `click_events` with new columns
- `server/src/db.ts` — add migration for new `click_events` columns
- `worker/src/index.ts` — `/track` handler: verify signed token, fall back to legacy format, pass `query_id` and `destination` to `referral-click` endpoint

### Acceptance criteria

- [ ] A bot query response contains a `/track?t=<signed-token>` URL (not cleartext params)
- [ ] Clicking that link logs a row in `click_events` with `destination` and `query_id` populated
- [ ] `queries.referral_clicked` is updated to 1 for the originating query row
- [ ] A token with a tampered HMAC is rejected with a 400 (no click logged, redirect still happens)
- [ ] A token older than 90 days is rejected
- [ ] A legacy cleartext `/track?to=...` URL still works and logs `legacy = 1`
- [ ] `GET /analytics/:slug` still returns correct `referral_clicks` count

---

## Session 2 — Per-Bot Response Tuning

**Scope:** Branch the Claude system prompt by detected crawler. Each bot family gets a structurally different response optimized for how that crawler surfaces content to end users.

- One prompt file per bot family in `server/src/prompts/` (e.g. `perplexity.ts`, `gpt.ts`, `claude.ts`, `google.ts`, `default.ts`)
- `buildSystemPrompt()` in `builder.ts` gains a `crawlerFamily` parameter and selects the appropriate prompt module
- Intent classifier (`detectIntent`) is unchanged — it feeds the same intent signal into each per-bot prompt
- Prompt files are the only new thing; routing, logging, and response shape are unchanged
- Update `docs/response-generation.md` after shipping

---

## Session 3 — MCP Server Distribution

**Scope:** Make `/mcp` submission-ready for public MCP directories.

- Align with the latest MCP spec (check spec version at implementation time)
- Add a manifest/discovery endpoint (e.g. `GET /mcp/manifest`) per spec requirements
- Add per-IP rate limiting via a Cloudflare Durable Object on the Worker's `/mcp` proxy
- Add structured logging on every MCP tool call (tool name, slug, latency, error)
- Test against Claude Desktop and Cursor before submitting
- Update `docs/mcp-server.md` after shipping

---

## Session 4 — Competitor Radar

**Scope:** Weekly automated intelligence on how AI tools answer category queries for our customers' market segments.

- Cron job (Railway or Cloudflare Cron Trigger) fires once per week
- For each registered business: send 3–5 category-level queries to ChatGPT, Perplexity, and Gemini (using their public APIs or search interfaces)
- Parse responses for competitor business mentions
- Aggregate into a per-customer weekly report
- Send Monday morning summary email via Resend to the business's registered email address
- Store raw results in a new `competitor_mentions` table in SQLite for trend analysis
- Update `docs/` with a new `competitor-radar.md` after shipping

---

## Session 5 — AI Handoff (Client-Side Intent Script)

**Scope:** Let customer websites read decoded intent from the attribution token so they can personalize the landing experience for AI-referred visitors.

- New endpoint: `GET /r/:token/decode` on Railway — verifies the signed token, returns `{ intent, ref, slug }` as JSON (no redirect, no PII)
- Vanilla TypeScript script (`public/advocate-context.js`) under 12kb gzipped
- Customers add one `<script>` tag; the script reads the URL for a `t=` param, calls `/decode`, and writes `window.advocateContext = { intent, ref, slug }` for their own JS to consume
- No SPA framework, no build step, single file
- Update `docs/attribution.md` after shipping

---

## Session 6 — ai-agent.json as a Published Standard

**Scope:** Formalize `ai-agent.json` as an open standard with a public spec page.

- Public spec page served by the Worker at `/spec` — static HTML, no framework
- Separate GitHub repo `ai-agent-spec` with reference implementation, JSON Schema, and example files
- Version the spec (currently `1.0`) and add a changelog
- Outreach to AI crawler teams (Perplexity, OpenAI, Anthropic, Google) to check for `/.well-known/ai-agent.json` before scraping
- Update `docs/` with a new `ai-agent-standard.md` after shipping

---

## Session 7 — Off-Site Authority Kit

**Scope:** Per-customer report identifying citation opportunities on authoritative third-party platforms.

- New `/dashboard/authority` tab in the client portal
- Backend analyzes each business's category, location, and services against a curated list of citation platforms: Reddit (relevant subreddits), Wikidata, Google Business Profile, Yelp, review platforms, YouTube
- Generates a prioritized outreach checklist: "You are not cited on X — here's how to fix it"
- Tracks outreach status per platform (not started / in progress / done)
- Stores in a new `authority_opportunities` table in SQLite
- Update `docs/` with a new `authority-kit.md` after shipping
