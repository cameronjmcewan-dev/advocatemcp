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

**Bug 1 — Malformed proxy URL (`/agents/agents/query` instead of `/agents/:slug/query`).**
When a request hits `customers.advocatemcp.com/agents/dmre/query`, the Worker's path rewriting produces a doubled-path URL on the downstream Railway request. The slug is lost in path construction. Reproducible by curling the Worker URL directly. Does not affect the bot-detection path where the slug is resolved from KV and the Railway URL is constructed explicitly.

**Bug 2 — Missing `X-API-Key` forwarding on the proxy path.**
The same `customers.advocatemcp.com/agents/:slug/query` proxy path does not forward `env.API_KEY` as `X-API-Key` to Railway, resulting in 401 responses. The bot-detection path at `worker/src/index.ts` line 328 adds the header correctly. A different code path serving the proxy is missing the same logic. Both bugs should be fixed together in a dedicated worker proxy cleanup session before any customer onboards via `customers.advocatemcp.com` as their primary integration surface.

## Updating this doc

Update this file at the end of any session that touches `/track`, `click_events`, `tracked-url.ts`, or the `referral-click` endpoint.
