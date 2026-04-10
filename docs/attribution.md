# Attribution

## What exists today

Attribution is a partial end-to-end system. The existing pieces are functional; Session 1 closes four specific gaps to make it complete and tamper-resistant.

**Existing flow:**
1. Railway's agent endpoint returns `{ response, referral_url, ... }` to the Worker.
2. The Worker UTM-tags the `referral_url` and wraps it in a `/track` redirect URL: `GET /track?to=<utm-tagged-dest>&ref=<botName>&client=<slug>`. This wrapped URL is returned to the crawler as `tagged_referral_url`.
3. The crawler includes the link in its response to the human user.
4. The human clicks → browser hits `GET /track` on the Worker.
5. Worker checks: is `dest` and `client` present, and is the UA not an AI crawler? If yes, it hashes the IP with SHA-256 and fires `ctx.waitUntil(POST /analytics/:slug/referral-click)` to Railway — server-side logging, no customer callback required.
6. Railway inserts a row into `click_events (business_slug, ref, user_agent, ip_hash)` and 302s the user to the destination.
7. `GET /analytics/:slug` surfaces `referral_clicks` (all-time) and `referral_clicks_last_30_days` from `click_events`.

**The four gaps closed in Session 1:**

**Gap 1 — query_id linkage.** The Railway agent endpoint now returns `query_id` in its response payload. The Worker encodes it in the `/track` URL. The Railway `referral-click` handler uses it to update `queries.referral_clicked = 1` at insert time, closing the loop: query → response → click.

**Gap 2 — destination on click_events.** A `destination TEXT` column is added to `click_events` via migration. The `/track` handler passes `to` through to the `referral-click` endpoint and it is stored. Old rows have `NULL` destination.

**Gap 3 — signed tokens.** The cleartext query-string format is replaced with a single HMAC-SHA256 signed token: `GET /track?t=<base64url(payload).hmac>`. Payload encodes `{ destination, ref, slug, query_id, iat }`. Signed with `TOKEN_SIGNING_KEY` (Wrangler secret + Railway env var, identical values). Tokens older than 90 days are rejected. Token generation lives in `server/src/lib/tracked-url.ts`; verification lives in `worker/src/lib/tracked-url.ts`. Logic is identical in both — if they diverge, tokens break. Legacy cleartext format is accepted with `legacy = 1` flag in `click_events` for monitoring during rollover.

**Gap 4 — referral_clicked update.** Covered by Gap 1. The `referral-click` handler updates `queries.referral_clicked = 1 WHERE id = query_id` in the same transaction as the `click_events` insert.

## Database tables involved

- `queries.referral_clicked` — updated to 1 on click
- `queries.intent` — classified at query time, included in token payload for future use
- `click_events` — one row per human click: `business_slug, ref, user_agent, ip_hash, destination, query_id, legacy`

## Token format (post Session 1)

```
/track?t=<token>
token = base64url(JSON.stringify(payload)) + "." + base64url(hmac)
payload = { dest: string, ref: string, slug: string, qid: number, iat: number }
```

HMAC is computed over the raw base64url payload string using HMAC-SHA256 with `TOKEN_SIGNING_KEY`. The Worker verifies the HMAC before trusting any payload field. Token lifetime is 90 days (`iat` checked at verification time).

## Known issues — deferred from Session 1

These two bugs were discovered during Session 1 final verification when testing `customers.advocatemcp.com/agents/:slug/query` directly. They are **not** regressions introduced by Session 1. They do not affect the primary bot-detection flow (customer domain → KV lookup → Railway agent), which was not directly testable without DNS. Both bugs live in the Worker proxy path used when `customers.advocatemcp.com` is the integration surface.

**Bug 1 — Malformed proxy URL (`/agents/agents/query` instead of `/agents/:slug/query`).**
When a request hits `customers.advocatemcp.com/agents/dmre/query`, the Worker's path rewriting produces a doubled-path URL (`/agents/agents/dmre/query` or similar) on the downstream Railway request. The slug is lost in path construction. Reproducible by curling the Worker URL directly. Does not affect the bot-detection path where the slug is resolved from KV and the Railway URL is constructed explicitly.

**Bug 2 — Missing `X-API-Key` forwarding on the proxy path.**
The same `customers.advocatemcp.com/agents/:slug/query` proxy path does not forward `env.API_KEY` as `X-API-Key` to Railway, resulting in 401 responses. The bot-detection path at `worker/src/index.ts` line 328 adds the header correctly. A different code path serving the proxy is missing the same logic. Both bugs should be fixed together in a dedicated worker proxy cleanup session before any customer onboards via `customers.advocatemcp.com` as their primary integration surface.

## Updating this doc

Update this file at the end of any session that touches `/track`, `click_events`, `tracked-url.ts`, or the `referral-click` endpoint.
