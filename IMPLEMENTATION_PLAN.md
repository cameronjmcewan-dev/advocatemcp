# AdvocateMCP — Implementation Plan

Sessions must be completed in order. Session 1 is non-negotiable as first because signed tokens and query_id linkage are prerequisites for every downstream analytics feature. After each session ships, update the relevant `docs/` file and commit.

---

## Session 1 — Attribution Hardening

**Status: SHIPPED 2026-04-10** — server: `80358b9`, worker: `ce36cdf`, docs: `edbaad6`

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

- [x] A bot query response contains a `/track?t=<signed-token>` URL (not cleartext params)
- [x] Clicking that link logs a row in `click_events` with `destination` and `query_id` populated
- [x] `queries.referral_clicked` is updated to 1 for the originating query row
- [x] A token with a tampered HMAC is rejected (no click logged, redirect still happens)
- [x] A token older than 90 days is rejected
- [x] A legacy cleartext `/track?to=...` URL still works and logs `legacy = 1`
- [x] `GET /analytics/:slug` still returns correct `referral_clicks` count

---

## Session 1.5 — customers.advocatemcp.com Proxy Cleanup

**Status: SHIPPED 2026-04-10** — worker deploy version: `8205237e-e247-494f-91d3-ea75d2168fde`. Commit: `a2d0f8a`.

**Scope:** Fix the two documented proxy bugs in the `customers.advocatemcp.com/agents/:slug/query` path before any Stripe self-serve customer onboards and hits them. Half-day session. See `docs/attribution.md` for full bug descriptions and the Phase 1.5 post-mortem notes on the API_KEY runtime drift discovered during verification.

**Bug 1 — Doubled-slug URL** (`/agents/agents/query`): the bot-detection dispatch's first-path-segment slug fallback at `worker/src/index.ts` was treating `"agents"` as the slug for requests to `/agents/:slug/query` because `"agents"` was not in the `RESERVED` set. The resulting downstream Railway URL was `${base}/agents/agents/query`. Fixed by adding a dedicated platform-scoped route at dispatch step (2c), parallel to the `/mcp` proxy, that matches `POST /agents/:slug/query` via regex, extracts the slug from the URL path explicitly, and forwards `request.body` and `X-API-Key` to Railway. Scoped via `WORKER_HOSTNAMES` (the shared `ReadonlySet` exported from `worker/src/lib/proxy.ts`, also used by Phase 1 runtime loop detection and Phase 2 origin-discovery) so the bot-detection flow on real customer domains is unchanged byte-for-byte. `"agents"` added to the `RESERVED` set as belt-and-suspenders against a future removal of the dedicated route silently re-introducing the bug.

**Bug 2 — Missing `X-API-Key` forwarding**: investigated and found already fixed in current `main` at the time of Phase 1.5. Exhaustive grep of every `fetch()` call to Railway in `worker/src/` confirmed only one `/agents/:slug/query` proxy path exists (the bot-detection path at step 4) and it already forwards `env.API_KEY` as `X-API-Key`. No code change required. Either Bug 2 was silently resolved during Phase 1 or Phase 2 refactoring without a doc update, or the original bug description in `attribution.md` was slightly off. The new smoke test catches any future regression of either Bug 1 or Bug 2 in a single assertion.

**Production state observation — API_KEY runtime drift.** During Phase 1.5 pre-commit verification, a live test against the deployed worker revealed that Railway was rejecting every worker → Railway agent query with `401 Invalid or missing api_key`. The worker code was correctly forwarding `X-API-Key` (verified by static grep and the Phase 1.5 implementation), but the runtime value of `env.API_KEY` on the deployed worker did not match `process.env.API_KEY` on Railway. The original cause of the drift is unknown — not speculating. Reconciled on 2026-04-10 by setting the same value on both sides and verifying the worker → Railway chain end-to-end. Full entry including operational lessons captured in `docs/attribution.md` under "Production state observations".

### Production verification (2026-04-10)

Post-deploy curl against the new platform route confirmed:

- Request correctly matched the dispatch step (2c) regex on the `customers.advocatemcp.com` hostname.
- Slug extracted as `dmre` from the URL path — not corrupted to `"agents"` by the fallback as it was pre-fix.
- `X-API-Key` forwarded to Railway and accepted (auth chain healthy after the API_KEY drift reconciliation).
- Downstream Railway reached its agent handler, which then errored on an **Anthropic billing 400 response** that is completely unrelated to Phase 1.5's scope. The error envelope was a clean Railway-shaped response, **not** the Worker-wrapped `detail.agentUrl: ".../agents/agents/query"` error shape that characterized Bug 1 before the fix. The chain worked all the way through to Anthropic before failing on a downstream balance issue, which confirms every layer Phase 1.5 touched is functioning correctly.

### Acceptance criteria

- [x] `POST customers.advocatemcp.com/agents/dmre/query` reaches Railway's agent handler and X-API-Key is accepted (verified post-deploy — downstream Anthropic billing 400 is out of scope)
- [x] The downstream Railway request URL is `/agents/dmre/query` — no doubled-slug variant (verified by error envelope shape)
- [x] Smoke test added to `worker/scripts/smoke-test.sh` section 9, three assertions: HTTP 200, body contains `powered_by`, body contains `business_slug":"dmre`. Crawler-UA requirement documented inline.
- [x] No change to the bot-detection path or KV routing

---

## Phase 1 — Origin Passthrough

**Status: SHIPPED 2026-04-10** — worker commit: `18c3848`, deploy version: `9728448b-cf1a-4c1f-a099-fbcfc4243f09`

**Summary:** Added a `proxyToOrigin` helper (`worker/src/lib/proxy.ts`) that transparently streams human traffic to a customer's real website, with loop detection returning 508 if the origin hostname matches any known Worker hostname or the incoming request's own hostname, WebSocket upgrade rejection (501), 30-second AbortController timeout returning 502 on failure, `redirect: "manual"` to pass 3xx through to the browser, and `Cache-Control: no-store` override on all proxied responses. The non-crawler branch in `index.ts` was rewritten to look up the tenant's `origin_url` from `TENANT_DATA` via `getTenant` and proxy if present, falling through to the existing info response if not configured. `handleActivateDomain` in `domains.ts` now validates that the slug exists in Railway before writing any KV or CF records, and validates `origin_url` as HTTPS with a HEAD reachability check (5s timeout, accepts 2xx/3xx/401, rejects 5xx or connection failure). The `origin_url` field was added to `TenantRecord` and threaded through `handleOnboard` so Phase 2 auto-discovery can update it without another code change. The stale commented tenant route block was removed from `wrangler.toml`.

### Production verification (2026-04-10)

| Check | Result |
|---|---|
| Test tenant seeded (TENANT_DATA KV write) | PASS |
| Human UA → Squarespace HTML with `cache-control: no-store` | PASS — HTTP/2 200, `<!DOCTYPE html>`, `set-cookie: SS_MID` confirmed origin reached |
| PerplexityBot UA → bot detection branch (not proxy branch) | PASS — HTTP 404 JSON from no-slug path, no Squarespace HTML |
| Cleanup delete succeeded | PASS — `customers.advocatemcp.com` removed from TENANT_DATA |

---

## Phase 2 — Origin Auto-Discovery

**Status: SHIPPED 2026-04-10** — worker deploy version: `500f081e-73cb-4507-a605-e04112f7c2d6`. Commits: `894529c` (implementation), `1f4c94e` (regression tests for unresolvable domains misreported as self_loop), `d5b1ba7` (semantic fix distinguishing unreachable domains from self-loop). Built directly on Phase 1 (`18c3848`).

**Scope:** Build on Phase 1 by making the activation flow discover the customer's origin URL automatically instead of requiring the admin to pass `origin_url` explicitly. When `POST /admin/domains/activate` is called without an `origin_url`, the Worker fetches `https://{domain}` with `redirect: "follow"` and a 10-second `AbortSignal.timeout`, then uses the final URL's scheme + host as the origin. Explicit `origin_url` in the request body still runs the Phase 1 validation path unchanged. The success response now surfaces `origin_url` and `origin_url_source: "explicit" | "discovered"` so the admin can see what was picked.

### Implementation details

- New `worker/src/lib/origin-discovery.ts` with `discoverOriginUrl(domain)` — GET with `redirect: "follow"`, body cancelled after response, identifies itself via `User-Agent: AdvocateMCP-Discovery/1.0 (+https://advocatemcp.com)`.
- Rejection reasons: `fetch_failed` (network error, DNS failure, or synthetic Cloudflare 5xx response on the same hostname — all indicate "domain is unreachable"), `fetch_timeout` (AbortError), `origin_5xx` (cross-host redirect + 5xx — real origin incident), `http_scheme` (redirect downgraded to HTTP), `self_loop` (cross-host check: same hostname + non-5xx), `worker_loop` (final hostname is a known AdvocateMCP Worker host). All return HTTP 400 with a structured `detail` payload.
- `WORKER_HOSTNAMES` is now exported from `worker/src/lib/proxy.ts` as a shared `ReadonlySet<string>` and imported by `origin-discovery.ts` — the runtime proxy loop check and the activation-time discovery check share one source of truth and can never drift.
- `handleActivateDomain` in `worker/src/routes/domains.ts` gains an `else` branch on `rawOriginUrl`: absent → call `discoverOriginUrl` → thread the result into `validatedOriginUrl` the same way an explicit value would be. Phase 1 explicit path runs byte-for-byte unchanged when `origin_url` is present.
- 17 unit tests in `worker/src/lib/origin-discovery.test.ts` cover single-hop redirect success, multi-hop redirect, self-loop rejection (case-insensitive), HTTPS→HTTP rejection, worker-hostname rejection, 5xx rejection, network error, AbortError timeout, 4xx final status acceptance, body-cancel verification, User-Agent header check, start URL construction, and four regression tests for the unresolvable-domain semantic boundary (same-host + 5xx → `fetch_failed`, same-host + 4xx/499 → `self_loop`, TypeError throw → `fetch_failed`, synthetic 530 → `fetch_failed`).
- **Semantic boundary note**: Cloudflare Workers' `fetch()` does NOT throw a TypeError on DNS resolution failure — it returns a synthetic Cloudflare error response (5xx status with the input URL preserved in `response.url`). Phase 2's initial implementation (commit `894529c`) hit `self_loop` on this path because the check order was `self_loop` before `origin_5xx`, and the synthetic response had `finalHostname === normalizedDomain`. Fixed in `d5b1ba7` by inserting a same-host 5xx check that maps to `fetch_failed` BEFORE the `self_loop` check. Regression tests in `1f4c94e` lock in the behavior.

### Production verification (2026-04-10)

| Test | Result |
|---|---|
| Test A — happy path, cross-host redirect auto-discovery | PASS — discovered origin matches the expected post-redirect hostname, `origin_url_source: "discovered"` |
| Test B — self-loop rejection for a site serving at its own hostname with no cross-host redirect | PASS — `reason: "self_loop"`, clear actionable error message with Cloudflare-challenge workaround hint |
| Test C — unreachable domain rejection for a nonexistent TLD | FAILED on first run, caught a real bug in initial Phase 2 implementation, fixed in `d5b1ba7`, re-ran → PASS with `reason: "fetch_failed"` |
| Test D — Phase 1 explicit `origin_url` path preserved unchanged | PASS — `origin_url_source: "explicit"`, same response shape as pre-Phase-2 |

### Known limitations (documented, not blocking)

- Sites fronted by Cloudflare with Under Attack Mode or a JS challenge page will return 200 from the customer's own hostname and trigger `self_loop` rejection. The error message explicitly calls out this case and tells customers to provide `origin_url` explicitly. Header-sniffing detection deferred — fragile on a maybe-problem.
- Discovery currently runs a fresh fetch on every activation call. No caching. Revisit if repeated activations for the same domain become a measurable cost.
- Integration test for `handleActivateDomain` itself deferred to a future testing-infrastructure session — the 17 discovery-level unit tests plus manual E2E are sufficient coverage for Phase 2.
- If a domain is already CNAMEd to `customers.advocatemcp.com` from a prior half-activated state, the discovery fetch may hit the Worker itself and produce a confusing error. Ordering the CF "already exists" short-circuit before discovery would fix it but is a Phase 1 flow change — out of scope for Phase 2.

---

## Phase 3 — Self-Serve Activation Flow (Spine)

**Status: SHIPPED 2026-04-10** — worker deploy version: `2e6760be-ed7e-4f06-8706-e154b0ec8519`. Commit: `c6042ba`.

**Scope:** Ship the spine for token-gated, post-payment domain activation. Future sessions will layer registrar-specific instructions, WHOIS-based registrar detection, Cloudflare verification polling, synthetic tests on completion, Stripe webhook token minting, rate limiting, and a Resend email sequence on top of this spine. None of that is in this phase — only the foundation those features will sit on. Spine is an intentional word: enough to be useful and exercisable end-to-end, deliberately incomplete on polish and automation.

The new flow lives at `/activate` (NOT `/onboard`). The existing `/onboard` wizard (`onboardPage.ts` ~1034 lines + `stripe.ts` ~1000 lines + `onboard.ts` ~904 lines) is a fully-shipped Stripe-wired 4-step funnel and was NOT touched — code archaeology during Phase 3 proposal caught a collision that would have fired if `/activate` had been implemented at the `/onboard` URL. The two flows are conceptually different customer journeys (marketing funnel vs post-payment activation) and deserve separate handlers. Future consolidation is a separate session.

### What shipped

- **`worker/src/lib/activation-token.ts`** — HMAC-SHA256 signed activation tokens. Same wire format as `tracked-url.ts` (base64url payload + `.` + base64url HMAC digest, HMAC computed over ASCII bytes of the encoded payload string) with a different payload shape (`{ slug, iat, exp }`) and a different signing key (`ACTIVATION_SIGNING_KEY`, isolated from `TOKEN_SIGNING_KEY` by purpose). Default TTL 24 hours. 8 unit tests in `activation-token.test.ts` covering round-trip, wrong-key rejection, tampered-signature rejection, malformed shapes, expired rejection, missing-fields rejection, iat/exp correctness, and default TTL constant.
- **`POST /api/activate`** (`worker/src/routes/activate.ts`) — customer-facing, token-authenticated. Accepts JSON body or form-encoded. Token via `X-Activation-Token` header, body field `token`, or query param `t=` (header preferred to minimize referer leak risk). Verifies token, normalizes + validates the domain, cross-tenant guards against `BUSINESS_MAP` entries owned by a different slug, delegates to the extracted `activateDomain` core, and wraps the success/failure result with customer-facing error codes and messages. 16 customer-facing error messages drafted in a deliberate voice (plain English, empathetic, action-oriented, no jargon, no exclamation marks).
- **`POST /admin/activation-token`** — temporary admin helper that mints an activation token + `activate_url` + `expires_at` for a given slug. X-Admin-Secret protected. **Explicitly temporary** pending Stripe webhook integration — the inline TODO comment marks it clearly, and this phase document calls it out as deferred (see below).
- **`GET /activate`** (`worker/src/routes/activatePage.ts`) — HTML page with five rendered states: State 0 (missing token, server-rendered short-circuit), State 1 (entry form), State 2 (submitting with spinner), State 3 (DNS instructions with per-field Copy buttons), State 4 (pending verification acknowledgment). Uses `sharedLayout.ts` for all chrome and tokens — no hardcoded hex colors. Vanilla JS state machine under 5kb. Native form POST fallback for no-JS clients.
- **Surgical refactor of `worker/src/routes/domains.ts`**: extracted the core activation logic (slug validation → origin URL resolution → Cloudflare API → KV/D1/TENANT_DATA persistence) into a new exported function `activateDomain(env, { domain, slug, originUrl? })` that returns a typed `ActivateDomainResult` with a stable `ActivateFailReason` tag on failure. `handleActivateDomain` is now a thin HTTP wrapper that checks admin secret, parses JSON body, and delegates. Zero semantic change to the admin endpoint — response shape and status codes are identical byte-for-byte. Both `handleActivateDomain` and the new `handleActivate` call the same core.
- **`worker/src/types.ts`** — new `ACTIVATION_SIGNING_KEY?: string` field on `Env` with an inline comment explaining purpose and how to set it via wrangler secret.
- **`worker/src/routes/portal.ts`** — three new route registrations (`GET /activate`, `POST /api/activate`, `POST /admin/activation-token`) inserted additively in the existing dispatch block. Zero modification to any existing route.
- **`worker/src/index.ts`** — `"activate"` added to the RESERVED set in the bot-detection slug fallback. Defense-in-depth against a future removal of the `/activate` route silently re-introducing the route through the first-path-segment fallback. Same pattern as Phase 1.5's `"agents"` addition.

### Production verification (2026-04-10)

Partial E2E verification in browser after deploy. The happy path was not fully exercised — see the gap note below.

| Check | Result |
|---|---|
| State 0 (missing token) renders correctly | PASS — verified earlier, screenshotted |
| State 1 (entry form) renders with sharedLayout chrome, correct typography, working form interactions, Continue button triggers submit | PASS |
| Error path end-to-end: `dmre.com` auto-discovered as self-loop, returns `origin_unknown_need_host`, renders the full `customer_message` error banner in the exact drafted wording, preserves form context | PASS |
| Voice and copy match the Phase 3 proposal drafts byte-for-byte in the live HTTP response | PASS |
| `POST /admin/activation-token` with real admin secret mints a valid token | PASS (verified indirectly via the error-path flow using a minted token) |
| State 3 (DNS instructions with Copy buttons) rendered against a real cross-host-redirecting domain | NOT VERIFIED — partial coverage gap |
| State 4 (pending verification) transition via "I've added the records" button | NOT VERIFIED — partial coverage gap |

**Gap acknowledgment**: the happy path (State 3 DNS records render → Copy buttons → State 4 pending verification) was not exercised in Phase 3 verification. The `dmre.com` self-loop behavior is the expected Phase 2 limitation (documented in `docs/attribution.md`): `dmre.com` either isn't redirecting cross-host or has residual KV state from earlier E2E sessions, and in either case Phase 3 is correctly surfacing the error — which validates the error path end-to-end but not the success path. The happy path code is a mechanical rendering of the same response shape `/admin/domains/activate` has returned successfully across multiple prior phases (Phase 1, Phase 2, Phase 1.5 all exercised it post-deploy), so confidence the happy path will work when exercised is high. Full State 3 → State 4 E2E will be exercised either on the first real cross-host-redirecting customer domain to run through the flow, or during a dedicated post-consolidation test session with a purpose-built test domain.

### Deferred — explicitly out of Phase 3 spine scope

These are intentional, approved cuts from the Phase 3 proposal, captured here so a future session doesn't have to re-derive them:

- **Registrar-specific instructions** per platform (GoDaddy, Namecheap, Squarespace, etc.). Generic help text only tonight — "your domain registrar, whoever that is" with three illustrative examples inline.
- **WHOIS-based registrar detection** — out of scope. Tie-in to registrar-specific instructions once both exist.
- **Cloudflare verification polling** on State 4. Manual refresh only tonight. Auto-polling is additive for a future session.
- **Synthetic test on completion** — no post-activation smoke call to prove the tenant is fully live. Customer has to manually refresh.
- **Stripe webhook integration** for automatic token minting on successful payment. `POST /admin/activation-token` exists as the manual stopgap with an inline `TODO(stripe-webhook)` comment. **This endpoint is explicitly temporary** — it should be removed or re-scoped to ops-only testing when the webhook lands.
- **Resend email sequence** — no email is sent when a customer completes State 4. State 4 copy is honest about this ("we're working on the automatic email") rather than misleading.
- **Rate limiting** on `/api/activate` or `GET /activate`. 24-hour token expiry is the only limiter. Bad actor with a leaked token could submit arbitrary domains until the token expires.
- **GET-side token verification** on `GET /activate`. Verification happens on POST only. Trade-off: ~1 second of delay between form submission and bad-token error surfacing, in exchange for one place token logic lives. Approved.
- **No-JS HTML response path** on the backend. `POST /api/activate` returns JSON only. Without JavaScript, the native form POST lands the customer on a raw JSON response page. Functional but ugly. HTML response negotiation deferred.
- **Integration test for `/api/activate`** — deferred to a future testing-infrastructure session, same precedent as Phase 1.5 and Phase 2. Unit tests on the token layer plus manual E2E are sufficient coverage for the Phase 3 spine.
- **Real cross-host-redirecting domain happy-path E2E verification** — see the gap note above. Will land in a follow-up.
- **Visual polish** beyond sharedLayout defaults. Typography, spacing, the Copy button micro-interaction — all intentionally minimal. Polish is a design session, not a spine session.

### Placeholder to swap in a future session

All customer-facing error states and the missing-token short-circuit link to `mailto:max@advocate-mcp.com` as the support contact. This is a placeholder — the real support address (or form URL, Discord link, whatever channel is chosen) gets swapped in a follow-up. `grep -rn "max@advocate-mcp.com" worker/src/routes/` finds every occurrence.

---

## Session 2 — Per-Bot Response Tuning

**Scope:** Branch the Claude system prompt by detected crawler. Each bot family gets a structurally different response optimized for how that crawler surfaces content to end users.

### Prep (do before writing any code)

Run three real customer queries (representative tenants across different categories) against the live UIs of Perplexity, ChatGPT, Claude, and Gemini. Screenshot how each AI structures its answers — citations, bullet points, conversational tone, freshness emphasis, ordering. Save screenshots to `docs/session-2-research/`. Per-bot prompts get designed by reverse-engineering observed structure, not by intuition.

### Design decisions (pre-made)

- **Default fallback prompt**: a copy of today's single prompt — stable and known-good — not a deliberately generic version. Add one-line logging to the prompt dispatcher that records which crawler triggered the default path so we can identify new bots worth adding explicit prompts for over time.
- **Intent signal**: `detectIntent` is unchanged — it feeds the same six-category signal into each per-bot prompt as an input, not something to branch on independently.

### Implementation

- One prompt file per bot family in `server/src/prompts/` (e.g. `perplexity.ts`, `gpt.ts`, `claude.ts`, `google.ts`, `default.ts`)
- `buildSystemPrompt()` in `builder.ts` gains a `crawlerFamily` parameter and selects the appropriate prompt module
- Prompt files are the only new thing; routing, logging, and response shape are unchanged
- Update `docs/response-generation.md` after shipping

### Acceptance criteria

- [ ] Each supported crawler family gets a structurally distinct system prompt verified against the session-2-research screenshots
- [ ] Unknown/new crawlers fall through to `default.ts` (copy of pre-Session-2 prompt); the prompt dispatcher logs `prompt_default_fallback` with the raw crawler UA so new bots are visible in logs
- [ ] `GET /analytics/:slug/by-crawler` endpoint returns citation conversion rate per crawler over the last 30 days, computed from existing `queries.crawler_agent` and `queries.referral_clicked` columns — this is the eval harness that confirms whether per-bot tuning is working post-deploy
- [ ] Snapshot regression test: captures the response for one canonical query against one canonical business on the `default.ts` path and asserts the post-Session-2 default produces the same response — prevents silent quality regressions for unmatched crawlers
- [ ] All existing tests pass; typecheck clean

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
