# Attribution

## Current state (post Session 1 — shipped 2026-04-10)

The attribution system is a closed end-to-end loop: bot query → signed response → human click → logged click event → query row updated. All four Session 1 gaps are closed and verified in production.

## Full flow

1. An AI crawler hits a customer domain. The Worker resolves the slug via KV and proxies the query to Railway's `POST /agents/:slug/query`.
2. Railway runs the Claude agent, inserts a row into `queries`, and captures the `lastInsertRowid` as `query_id`.
3. Railway builds a signed attribution token via `buildToken()` in `server/src/lib/tracked-url.ts`. Token payload: `{ dest, ref, slug, query_id, ts }`. Signed with HMAC-SHA256 over the base64url-encoded payload string using `TOKEN_SIGNING_KEY`.
4. Railway returns `{ response, referral_url, query_id, attribution_token, ... }` to the Worker.
5. The Worker UTM-tags the `referral_url` and builds the tracking URL. If `attribution_token` is present (always in normal operation): `GET /track?t=<token>`. If absent (degenerate fallback): `GET /track?to=<utm-dest>&ref=<bot>&client=<slug>`. The tracking URL is returned to the crawler as `tagged_referral_url`.
6. The crawler includes the link in its answer to the human user.
7. Human clicks → browser hits `GET /track` on the Worker.
8. **Signed path** (`?t=`): Worker calls `verifyToken()` in `worker/src/lib/tracked-url.ts`. Verifies HMAC byte-for-byte, rejects if token is > 90 days old. On success: fires `ctx.waitUntil(POST /analytics/:slug/referral-click)` with `{ ref, user_agent, ip_hash, destination, query_id, legacy: 0 }`. Logs `track_signed_click` metric. Redirects to `payload.dest`.
9. **Legacy path** (`?to=`): fires the same POST with `{ ref, user_agent, ip_hash, legacy: 1 }`. Logs `track_legacy_click` metric. The legacy path stays live until `legacy=1` rows in `click_events` decay to zero.
10. **Verification failure** (bad HMAC / expired / malformed): logs `track_verification_failure` with reason, redirects to best-effort destination via `safeFallbackDest()` (decodes payload half if parseable, falls back to `apiBase`). No click is logged.
11. Railway's `referral-click` handler: cross-tenant guard checks `query_id` belongs to `slug` before touching anything. Inserts into `click_events (business_slug, ref, user_agent, ip_hash, destination, query_id, legacy)`. Updates `queries.referral_clicked = 1 WHERE id = query_id` in the same statement.

## Token format

```
/track?t=<token>
token      = <encodedPayload>.<encodedSig>
encodedPayload = base64url(JSON.stringify({ dest, ref, slug, query_id, ts }))
encodedSig     = base64url(HMAC-SHA256(ASCII_bytes(encodedPayload), TOKEN_SIGNING_KEY))
```

**Critical**: HMAC is computed over the ASCII bytes of the `encodedPayload` string, not the raw JSON bytes and not the decoded bytes. Both `server/src/lib/tracked-url.ts` and `worker/src/lib/tracked-url.ts` include an explicit comment explaining this — it is the most common cross-implementation drift point. A shared test vector (`KNOWN_TOKEN`) in both test files enforces parity; if either environment produces a different result, the signing logic diverged. Do not update the constant — fix the code.

Token lifetime is 90 days (`ts` checked at verification time).

## Session 0 primitives — request_id and `aid` token claim

Two small primitives threaded through the attribution path so every request has a stable correlation handle and every token can (optionally) carry one. Both are additive — they do not change any existing on-wire format for callers that ignore them.

### `x-advocate-request-id` header

Every request into Railway goes through the `requestId` helper at [server/src/lib/requestId.ts](server/src/lib/requestId.ts), which:

- Accepts an inbound `x-advocate-request-id` header if present **and** well-formed (ULID — 26 chars, Crockford base32). Malformed values are discarded silently rather than rejected, so an upstream caller passing garbage never breaks the request.
- Mints a fresh ULID if no valid inbound ID is present.
- Echoes the resolved ID back on the response as the same `x-advocate-request-id` header, so clients and the Worker can pin logs to the same ID the server persisted.
- Persists the resolved ID into the `queries.request_id` column on the `queries` insert, giving every query row an end-to-end correlation handle that spans Worker logs, Railway logs, and the DB.

ULID is chosen (over UUIDv4) for lexicographic time-ordering — useful for log scans and for debugging bot-burst patterns without a separate timestamp join. The helper's header read is case-insensitive per HTTP semantics; header writes use the lowercase canonical form.

### Optional `aid?: string` claim on the signed token

The token `TokenPayload` in [server/src/lib/tracked-url.ts](server/src/lib/tracked-url.ts) and [worker/src/lib/tracked-url.ts](worker/src/lib/tracked-url.ts) gains an **optional** `aid?: string` field for per-assistant / per-agent attribution (e.g. distinguishing different Claude-powered surfaces that share a slug).

**Back-compat guarantee — byte-identical tokens when `aid` is absent.**

A token minted before Session 0 and a post-Session-0 token built from the same `{dest, ref, slug, query_id, ts}` payload with `aid` omitted must be byte-for-byte identical — same `encodedPayload`, same signature, same full token string. This matters because:

- Cached / in-flight tracking URLs issued before Session 0 must continue to verify without re-signing.
- The cross-env parity test vector (`KNOWN_TOKEN`) in both `tracked-url.test.ts` files is an existing pre-`aid` token and must not change.

The `buildToken` implementation achieves this by omitting `aid` from the JSON payload when the caller does not pass it (i.e. `aid` is `undefined`, not `null` or `""`). `JSON.stringify` already drops `undefined` property values, so the serialized string is identical to the pre-Session-0 form. Do not "normalize" the payload by inserting `aid: null` — that would break every pre-Session-0 token on the next verification.

Verification on the Worker side accepts tokens with and without `aid` — the field is only read when present, and its absence is not a rejection reason.

## Structured log metrics on /track

| Metric | When emitted | Key fields |
|--------|-------------|-----------|
| `track_signed_click` | Signed token verified, human UA, click logged | `slug`, `query_id`, `ts` |
| `track_legacy_click` | Legacy `?to=` path, human UA, click logged | `slug` |
| `track_verification_failure` | Bad HMAC, expired, or malformed token | `reason` (`bad_signature` \| `expired` \| `malformed`) |

Use `track_signed_click` / (`track_signed_click` + `track_legacy_click`) ratio to monitor legacy decay. When legacy ratio ≈ 0 for 30+ days, the legacy fallback code in `worker/src/index.ts` can be removed.

## Database tables involved

- `queries.referral_clicked` — updated to 1 on click (via `query_id` linkage)
- `queries.intent` — classified at query time, stored per row
- `click_events` — one row per human click: `business_slug, ref, user_agent, ip_hash, destination, query_id, legacy`

## Key files

| File | Role |
|------|------|
| `server/src/lib/tracked-url.ts` | `buildToken()` — Node crypto, synchronous HMAC-SHA256 |
| `server/src/lib/tracked-url.test.ts` | 6 tests; holds `KNOWN_TOKEN` reference constant |
| `worker/src/lib/tracked-url.ts` | `verifyToken()`, `base64urlToBytes()` — Web Crypto, async |
| `worker/src/lib/tracked-url.test.ts` | 7 tests; same `KNOWN_TOKEN` constant — cross-env parity check |
| `server/src/routes/analytics.ts` | `referral-click` handler — cross-tenant guard, `click_events` insert, `queries` update |
| `worker/src/index.ts` | `/track` dual-path handler, `safeFallbackDest()`, `trackingUrl` construction |

## Known issues — deferred from Session 1

These bugs were discovered during Session 1 final verification when testing `customers.advocatemcp.com/agents/:slug/query` directly. They are not regressions introduced by Session 1. They do not affect the primary bot-detection flow (customer domain → KV lookup → Railway agent), which was not directly testable without DNS. Both bugs live in the Worker proxy path used when `customers.advocatemcp.com` is the integration surface.

**Bug 1 — Malformed proxy URL (`/agents/agents/query` instead of `/agents/:slug/query`).** [RESOLVED 2026-04-10 — Phase 1.5]
When a request hits `customers.advocatemcp.com/agents/dmre/query` with a crawler User-Agent, the Worker's first-path-segment slug fallback at `worker/src/index.ts` (previously around line 349) resolved the slug as `"agents"` because `"agents"` was not in the `RESERVED` set. That produced a downstream URL of `https://advocate-production-2887.up.railway.app/agents/agents/query` on Railway, which 404'd. Fixed in Phase 1.5 by adding a dedicated `POST /agents/:slug/query` route at `index.ts` dispatch step (2c), scoped via `WORKER_HOSTNAMES` to platform hostnames only so the bot-detection flow on real customer domains stays unchanged. The slug is now pulled from the URL path explicitly. `"agents"` was also added to the `RESERVED` set as belt-and-suspenders defense against a future removal of the dedicated route silently re-introducing the bug.

*Note on trigger conditions discovered during Phase 1.5 verification*: the bug only manifests when the request carries a crawler User-Agent. A non-crawler UA hits the non-crawler short-circuit at `index.ts:310` and returns a 200 "Non-crawler request — no agent response generated" info response before ever reaching the slug fallback. This means any smoke test exercising the proxy path must send a crawler UA (e.g. `GPTBot/1.1`) or the assertion is meaningless. Documented here so future session prep doesn't re-discover this the hard way.

**Bug 2 — Missing `X-API-Key` forwarding on the proxy path.** [RESOLVED — already fixed in code at the time of Phase 1.5 investigation]
Phase 1.5 investigation on 2026-04-10 found that the `/agents/:slug/query` fetch in `worker/src/index.ts` (at the bot-detection path) **already** forwards `env.API_KEY` as `X-API-Key`:

```typescript
headers: {
  "Content-Type": "application/json",
  ...(env.API_KEY ? { "X-API-Key": env.API_KEY } : {}),
}
```

The original bug description in this doc referred to "a different code path serving the proxy" but no such second code path exists in current `main` — there is only one `/agents/:slug/query` proxy path in the worker and it forwards the header correctly. An exhaustive grep of every `fetch()` call to Railway in `worker/src/` confirmed this (see the Phase 1.5 commit body for the full grep table). Either the bug was silently resolved during Phase 1 or Phase 2 refactoring and nobody updated this doc, or the original bug description was slightly off. Phase 1.5 added a smoke test that exercises the direct-proxy path end-to-end with both Bug 1 and Bug 2 as failure modes, so any regression in either direction will be caught.

## Production state observations — not bugs, flagged for future sessions

**API_KEY runtime drift (discovered and resolved 2026-04-10).**
During Phase 1.5 pre-commit verification, a live test against the deployed worker revealed that Railway was rejecting the worker's `X-API-Key` with `401 Invalid or missing api_key` — not because the worker code was missing the header (it wasn't), but because the runtime value of `env.API_KEY` on the deployed worker did not match `process.env.API_KEY` on Railway. The drift manifested as every worker → Railway agent query (including the bot-detection fallback path on `customers.advocatemcp.com/dmre`) returning `502 Backend returned an error` with a nested `401` from Railway. The drift did not affect customer onboarding or portal auth — those paths use separate credentials — but it did break every production crawler query from the worker until reconciliation.

The root cause of the drift is unknown — it could have originated from a worker-side rotation that was not propagated to Railway, or a Railway-side rotation that was not propagated to the worker. We are not speculating. The drift was reconciled on 2026-04-10 during Phase 1.5 by setting the same value on both sides and verifying the worker → Railway chain end-to-end.

Lessons and operational guidance:

1. A smoke test that hits the full worker → Railway chain end-to-end would have caught this when it first appeared. Phase 1.5 adds exactly that smoke test — see `worker/scripts/smoke-test.sh` section 9.
2. Any production state change that involves a shared secret must update both sides (worker wrangler secret AND Railway env var) in the same operation, and must be immediately followed by a cross-check call that exercises the full chain. Unilateral updates silently create drift that is invisible until a specific code path is exercised.
3. Static code analysis ("the code forwards the header") is necessary but not sufficient — runtime behavior may differ and requires a live call. This applies to any runtime-injected value, not just API keys.

**Missing `X-API-Key` on `/track` → `/analytics/:slug/referral-click`.**
The `/track` click logger in `worker/src/index.ts` at both the signed-token path and the legacy cleartext path POSTs to `${apiBase(env)}/analytics/:slug/referral-click` **without** forwarding `X-API-Key`. This is intentional as of 2026-04-10 and should not be "fixed" without a dedicated review of the `/track` endpoint's auth model. The `/track` endpoint is designed to be invoked by the end-user's browser during a referral-click redirect, not by a trusted server, so it has historically been public-ish on the Railway side. If a future session decides to lock down `/analytics/:slug/referral-click` behind server auth, the worker's `/track` handler will need to be updated at the same time and every currently-issued tracking URL in customer responses will need to be regenerated. Do not touch this without an explicit session scope — the blast radius is every referral click in flight.

## Session 5 — AI Handoff (client-side intent script)

**Shipped 2026-04-18.** Landing pages on customer domains can read an AI-referred visitor's intent + referring crawler + slug without any server-side integration.

### Flow

1. Perplexity / ChatGPT / etc. cites the tenant's agent response. The response contains a `/track?t=<signed-token>` URL.
2. A human clicks that URL. The worker's `/track` handler verifies the token, logs the click, then **redirects to `${dest}?amcp_t=<token>`** (not bare `dest`) — the token is forwarded on the redirect for human traffic only. AI-crawler redirects skip the token since crawlers don't run JS.
3. The customer's landing page has included `<script src="https://advocatemcp.com/advocate-context.js">` once. On load the script reads `?amcp_t=` from the URL, GETs `${apiBase}/r/<token>/decode`, and writes the result to `window.advocateContext`.
4. The script also dispatches a `CustomEvent('advocate:context', { detail })` on `window` and strips the `amcp_t` param from the URL via `history.replaceState`.

### `GET /r/:token/decode` (Railway)

- Verifies the HMAC on `TOKEN_SIGNING_KEY` via `server/src/lib/tracked-url.ts::verifyToken`.
- Joins `queries.intent` by the token's `query_id`. Returns `intent: null` if the row is missing or unclassified.
- Returns only `{ intent, ref, slug }`. Never exposes `dest`, `query_id`, `aid`, or any other token claim. CORS: `Access-Control-Allow-Origin: *`. Cache-Control: `private, max-age=60`.
- Rejections: `400 { error: "invalid_token", reason: "malformed" | "bad_signature" | "expired" }`.

### Script configuration

All optional, via data attributes on the `<script>` tag:

| Attribute | Default | Purpose |
|---|---|---|
| `data-api-base` | `https://api.advocatemcp.com` | Override for self-hosters |
| `data-param-name` | `amcp_t` | URL query-param key the script reads |
| `data-strip-url` | `true` | Set to `"false"` to leave the token in the URL after decoding |

### Customer integration example

```html
<script src="https://advocatemcp.com/advocate-context.js"></script>
<script>
  window.addEventListener("advocate:context", function (e) {
    var ctx = e.detail; // { intent, ref, slug }
    if (ctx.intent === "emergency") {
      document.querySelector("#hero-cta").textContent = "Call us right now";
    } else if (ctx.intent === "affordable") {
      document.querySelector("#hero-cta").textContent = "See our pricing";
    }
    document.body.setAttribute("data-ai-ref", ctx.ref);
  });
</script>
```

### Privacy posture

- Token carries no PII — only `{ dest, ref, slug, query_id, ts, aid? }`.
- Decode response deliberately excludes `dest` and `query_id` so a customer-owned JS context never sees fields that would let it reconstruct the click destination or correlate across tenants.
- Token is stripped from the URL on first decode so `document.referrer` on subsequent navigations doesn't leak it to third parties.
- Endpoint is not rate-limited beyond the shared `rateLimitMiddleware` on Railway; revisit if abuse appears.

## Updating this doc

Update this file at the end of any session that touches `/track`, `click_events`, `tracked-url.ts`, `/r/:token/decode`, `advocate-context.js`, or the `referral-click` endpoint.
