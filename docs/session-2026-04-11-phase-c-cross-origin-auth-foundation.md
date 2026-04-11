# Session 2026-04-11 — Phase C: Cross-Origin API and Auth Foundation

**Session type**: Backend and data-layer implementation session. Part of the rearchitecture plan at `docs/rearchitecture-plan-2026-04-10.md` Section 8 Phase C.

**Start time**: 2026-04-11, following the Phase B Stripe unblock that landed earlier in commit `653225a`.

---

## Context for future reference

This is a standalone session log following the Phase B precedent. If you're reading this without the surrounding conversation:

- **What Phase C is**: the backend and data-layer foundation for cross-origin auth between `advocatemcp.com` (frontend, Phase D) and `customers.advocatemcp.com` (backend, existing worker). Ships three new auth endpoints (`POST /api/auth/login`, `POST /api/auth/logout`, `POST /api/auth/refresh`), extends five existing endpoints with Bearer token support and CORS headers for the `advocatemcp.com` origin, and adds a schema migration for a new `tenant_id` column on the users table. No frontend code. No HTML. Nothing customer-visible beyond JSON responses.

- **What the ratified architectural decisions were** (not up for re-litigation in Phase C):
  - Hybrid Bearer access + refresh cookie pattern. Short-lived (15-minute) access tokens in memory on the frontend, long-lived (30-day) refresh tokens as `HttpOnly` `Secure` `SameSite=Strict` cookies scoped to `/api/auth/refresh` only.
  - Extend the existing `users` table in place — no parallel customer-users table. Add a `tenant_id` FK column. Use the existing `role` column with the existing `"client"` value for new Phase C users (not "customer" — that was a terminology difference between the advisory conversation and the actual schema). Rationale: the existing `role` column already expresses "non-admin users get a distinct role"; introducing "customer" would create a three-way split with no semantic benefit.

- **Ten open questions resolved before execution** (documented in full in the Phase C proposal from the 2026-04-11 conversation):
  1. Use `"client"` role terminology, not `"customer"`.
  2. Use existing `role` column, no scopes.
  3. Reuse in-house HMAC-SHA256 signed-token pattern for access tokens (new file `lib/access-token.ts`), new env var `ACCESS_TOKEN_SIGNING_KEY`.
  4. Ship `/api/auth/refresh` in Phase C — deferring would make Phase D impossible to build.
  5. Rotate refresh tokens on every `/api/auth/refresh` call.
  6. Include localhost origins (5173, 3000, 8788) in the CORS allow-list for Phase D local dev.
  7. Skip D1 integration tests for Phase C — unit tests only, manual E2E in session notes.
  8. Colocate the `getSessionFromRequest` middleware helper in `authApi.ts`.
  9. Set both `users.tenant_id` AND insert into `user_business_access` on customer creation — satisfies ratified decision AND keeps existing code working.
  10. Leave `stripe.ts`'s CORS helper untouched — Phase C uses the new shared helper for new/modified endpoints only.

---

## Commit sequence

Phase C originally proposed six commits. During Commit 1 execution a pre-existing flaky test was discovered in Phase 3's `activation-token.test.ts`, which required a dedicated pre-Commit-1 fix. The full sequence is therefore **seven commits**:

| # | Scope | Status | Commit |
|---|---|---|---|
| 0 | (Sidetrack) Deterministic tampered-signature test fix | shipped | `63f1e30` |
| 1 | Schema migration + types.ts field + session notes init | shipped | `d016946` |
| 2 | Access token library + unit tests | shipped | `5dc6289` |
| 3 | Shared CORS helper + unit tests | shipped | `06339a4` |
| 4 | Auth endpoints (login, logout, refresh) + cookie helpers + middleware | shipped | `48c5978` |
| 5 | Bearer middleware applied to existing endpoints + CORS dispatch lines | *(in progress)* | — |
| 6 | Final documentation + session notes finalization | not started | — |

### Commit 0 sidetrack — flaky test fix (2026-04-11)

During Commit 1 execution, after the D1 migration had been applied successfully and I ran `npm test` to verify existing tests still pass, the `activation-token.test.ts` test "rejects tokens with a tampered signature" failed unexpectedly. The test had passed at the start of Commit 1 (39/39 green before any file modifications). Nothing I had done in Commit 1 could have caused a regression in that test — the changes were purely additive (session notes file, migration SQL files, a new optional field in `types.ts`).

Stopped and investigated before attempting any fix. Root cause: a **pre-existing flaky test** written in Phase 3 (commit `c6042ba`, 2026-04-10) that swapped the last character of a signed token between "A" and "B" and expected verification to fail. The A↔B swap at the last position doesn't reliably change the decoded bytes because of base64url padding-bit mechanics:

- HMAC-SHA256 signatures are 256 bits.
- Base64url encodes 6 bits per character.
- 256 bits → 43 characters × 6 bits/char = 258 bits of capacity.
- The extra 2 bits on the last character are padding (conventionally zero, ignored by decoders).
- "A" = `000000` and "B" = `000001` — top 4 bits identical (`0000`), only the padding bits differ.
- Swapping A→B at the last character decodes to the same 32 bytes, the tampered signature still verifies, and the test fails.

**Theoretical flake rate**: ~6.25% per run (1 in 16, based on the probability that the signature's last character has all-zero top 4 bits). **Observed rate during Phase C investigation**: 3 failures in 8 consecutive runs. Small-sample variance, consistent with the theoretical rate.

Reported the finding to Cameron with three resolution options (fold fix into Commit 1 / pre-Commit-1 fix / ignore and commit red). Cameron approved Option B: dedicated pre-Commit-1 fix commit, so `git blame` correctly attributes the test change to its Phase 3 origin instead of muddying the Phase C schema commit. Cameron also specified the fix should use a **middle-character** swap (not first, not last) combined with a **top-4-bit flip** swap table for defensive determinism.

Fix implementation: `worker/src/lib/activation-token.test.ts` — tamper with the character at `Math.floor(sigLength / 2)` in the signature portion. Swap rule: if the character is in range `A-P` (top 4 bits ∈ `{0000, 0001, 0010, 0011}`) swap to `Q` (top 4 bits = `0100`); otherwise swap to `A` (top 4 bits = `0000`). The top 4 bits always differ after the swap, guaranteeing a decoded-byte change regardless of the original character.

Verification: 10 consecutive `npm test` runs, all 39/39 green after the fix. Flakiness gone.

**Commit 0 hash**: `63f1e30 fix(worker): deterministic tampered-signature test for activation tokens`. Pushed `653225a..63f1e30`. Test-only change, no production code affected.

### Why this story matters for institutional memory

This sidetrack is documented in full because the base64url padding-bit issue is a general pattern that could bite other tests or production code in unexpected contexts:

1. **Any test that tampers with the last character of a base64-encoded fixed-length binary value** is vulnerable to the same bug. The worker has another signed-token library (`worker/src/lib/tracked-url.ts`) with similar test structure — that file should be audited for the same anti-pattern in a future session. Noted in "Found during reading" below.

2. **Any code that assumes "changing a base64 character changes the decoded bytes"** is making an invariant that isn't universally true. The invariant holds for non-terminal characters but fails at the last character of encodings that straddle the padding boundary.

3. **The specific arithmetic** — 32 bytes = 256 bits, encoded in 43 base64 characters with 2 padding bits on the last character — is the same for every HMAC-SHA256 signature and every AES-256 key. Any future code that manipulates such values at the character level should use the middle-character modification pattern from the fix, not last-character modification.

Future sessions that hit similar base64 bugs can grep this file for "padding bit" and find the full analysis.

---

## Manual E2E verification plan (for after Commit 5 deploys)

Per Phase C's exit criteria, manual E2E verification captures `curl -v` raw output for every endpoint and auth path. Split responsibility:

**Claude runs (no secrets needed)**:
- `OPTIONS /api/auth/login` with `Origin: https://advocatemcp.com` → expect 204 + CORS headers incl. `Access-Control-Allow-Credentials: true`
- `OPTIONS /api/auth/login` with `Origin: https://evil.com` → expect 204 + default origin (not echoed)
- Same preflight pair for `/api/auth/logout`, `/api/auth/refresh`, `/api/client/me`, `/api/client/metrics`, `/api/client/activity`, `/api/client/rotate-key`, `/api/activate`
- `POST /api/auth/login` with wrong password → expect 401 `invalid_credentials`
- `POST /api/auth/login` with no body → expect 400 `invalid_body`
- `POST /api/auth/logout` with no auth → expect 200 idempotent
- `POST /api/auth/refresh` with no cookie → expect 401 `no_refresh_cookie`
- `POST /api/auth/refresh` with garbage cookie → expect 401 `invalid_refresh`
- `GET /api/client/me` with no auth → expect 401
- `GET /api/client/me` with random Bearer token → expect 401 (signature verification fails)

**Cameron runs (requires existing admin credentials or a valid session)**:
- `POST /api/auth/login` with valid admin credentials → expect 200 with access token + `Set-Cookie: amcp_refresh=...`
- `POST /api/auth/refresh` with the refresh cookie from above → expect 200 with new access token + rotated cookie
- `GET /api/client/me` with `Authorization: Bearer <access_token>` → expect 200 with user JSON
- `GET /api/client/me` with legacy `amcp_session` cookie (from an admin form login) → expect 200 with user JSON (backwards compat)
- `POST /api/auth/logout` with Bearer + refresh cookie → expect 200 with cookie-clearing Set-Cookie

All raw `curl -v` outputs are captured verbatim in the "Observed log output" section of this file. No `curl` output is paraphrased. Cameron pastes his outputs in chat; Claude pastes them into the notes file.

Claude's portion of the curls runs during Commit 5's verification step. Cameron's portion runs after Commit 5 is pushed and the worker has redeployed — Cameron paces Commit 6 on his schedule.

---

## Commit 1 — schema migration + types.ts field

### Files created in this commit

- `docs/session-2026-04-11-phase-c-cross-origin-auth-foundation.md` — this file
- `worker/migrations/0004_phase_c_auth.sql` — additive migration adding `users.tenant_id` column + index
- `worker/migrations/0004_phase_c_auth_rollback.sql` — rollback migration

### Files modified in this commit

- `worker/src/types.ts` — added `ACCESS_TOKEN_SIGNING_KEY?: string` field to `Env` interface with inline comment

### Migration safety

Additive only. `ALTER TABLE users ADD COLUMN tenant_id TEXT REFERENCES businesses(id)` adds a nullable column. Existing rows get NULL, no row-level validation failures, no data loss. The index is additive. Rollback is a straightforward `DROP COLUMN` + `DROP INDEX`, supported by D1's SQLite version.

### Commit 1 resume — baseline re-verification

After a wrangler OAuth auth outage that blocked the initial Commit 1 attempt (resolved out-of-session by Cameron re-authenticating), the baseline users table schema was re-verified on remote D1 before running the migration:

```
$ cd worker && npx wrangler d1 execute advocatemcp-auth --remote \
    --command "PRAGMA table_info(users);"
```

Result (columns only, cid + name extracted from the full PRAGMA output):

```
cid 0: id
cid 1: email
cid 2: password_hash
cid 3: salt
cid 4: full_name
cid 5: role
cid 6: created_at
cid 7: updated_at
```

Eight columns, no `tenant_id` — confirms the schema is at migration 0003 baseline, nothing unexpected happened during the auth outage window. Safe to apply 0004.

### Migration execution

```
$ cd worker && npx wrangler d1 execute advocatemcp-auth --remote \
    --file=migrations/0004_phase_c_auth.sql
```

Result:

```
🌀 Uploading 1247938a-cf98-4c66-8588-5c9d71699094.1a658ee514a6d68d.sql
🌀 Uploading complete.
🌀 Starting import...
🌀 Processed 2 queries.
🚣 Executed 2 queries in 2.73ms (33 rows read, 7 rows written)
   Database is currently at bookmark 00000031-00000006-0000504a-e768b9541798c8f875ead89f361d9f4a.

Total queries executed: 2
Rows read: 33
Rows written: 7
Database size (MB): 0.09
success: true
changed_db: true
```

Two queries executed: the `ALTER TABLE users ADD COLUMN tenant_id` and the `CREATE INDEX IF NOT EXISTS idx_users_tenant`. 7 rows written, `changed_db: true`, `success: true`. Migration applied cleanly.

### Verification queries

**Column verification** — `SELECT tenant_id FROM users LIMIT 1;` returns a row with `tenant_id: null`:

```json
{
  "results": [{ "tenant_id": null }],
  "success": true,
  "rows_read": 1,
  "rows_written": 0
}
```

The column exists and is queryable. The `tenant_id: null` value is expected — no user has been assigned a tenant yet since Phase C has not issued any customer logins. The absence of a "no such column" error is the success signal per the plan.

**Index verification** — `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_tenant';` returns one row with the index name:

```json
{
  "results": [{ "name": "idx_users_tenant" }],
  "success": true,
  "rows_read": 20,
  "rows_written": 0
}
```

Index `idx_users_tenant` exists in `sqlite_master`. Created by the migration's `CREATE INDEX IF NOT EXISTS` statement.

### Test suite status

After the Commit 0 sidetrack fix and with all Commit 1 changes in the working tree (session notes, migrations, types.ts):

```
$ cd worker && npm test
 RUN  v4.1.4 /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker
 Test Files  4 passed (4)
      Tests  39 passed (39)
   Duration  140ms
```

**39 of 39 tests passing.** No regressions from the schema migration or the types.ts addition. No new tests added in Commit 1 — new tests land in Commits 2 (access-token library) and 3 (CORS helper).

### Typecheck status

```
$ cd worker && npx tsc --noEmit
(no output)
```

Clean. The new optional `ACCESS_TOKEN_SIGNING_KEY?: string` field on the `Env` interface compiles without errors. Nothing in the existing code references it yet — that's Commits 2-5.

### Commit hash

*(to be populated after git commit)*

---

## Commit 2 — access token library + 10 unit tests

### Files created in this commit

- `worker/src/lib/access-token.ts` — HMAC-SHA256 signed access token library. Mirrors the structural layout of `activation-token.ts` exactly: file header comment explaining wire format + HMAC-over-ASCII rule + why-not-share rationale, `AccessTokenPayload` interface, `AccessTokenError` union, `ACCESS_TOKEN_TTL_SECONDS` constant (900 = 15 minutes), private `bytesToBase64url` helper, exported `base64urlToBytes` helper, `signAccessToken` function, `verifyAccessToken` function. The only structural differences from `activation-token.ts` are the richer payload shape (sub/role/tenant_id/email/full_name in addition to iat/exp), the 15-minute TTL instead of 24-hour, and the function names.
- `worker/src/lib/access-token.test.ts` — 10 unit tests following the `activation-token.test.ts` pattern. Includes two tests specific to the richer access-token payload shape (test 9 verifying all fields round-trip and test 10 verifying null tenant_id/full_name are accepted for admin users).

### Pattern reuse from activation-token.ts

The following was copied verbatim from `activation-token.ts` with only naming and payload-shape changes:

- base64url codec helpers (`bytesToBase64url`, `base64urlToBytes`) — byte-for-byte identical implementations
- HMAC-SHA256 import + sign flow via `crypto.subtle.importKey` and `crypto.subtle.sign`
- The HMAC-over-ASCII-bytes-of-encoded-payload-string rule
- Error type naming convention: `"malformed" | "bad_signature" | "expired"`
- Constant-time-ish signature byte comparison loop
- The shape validation pattern in `verify` — extended with additional field checks for the richer payload

The middle-character tamper pattern from Commit 0 (`63f1e30`) is reused in the test for "rejects tokens with a tampered signature" — same `Math.floor(sigLength / 2)` index calculation and same top-4-bit-flip swap table. The test file header explicitly warns future maintainers against "simplifying" the tamper logic back to a last-character A/B swap with a reference to the Phase C session notes for the full padding-bit analysis.

### Test count delta

- Before Commit 2: 39 tests across 4 test files
- After Commit 2: 49 tests across 5 test files (+10 tests, +1 file)

### Test suite status

```
$ cd worker && npm test
 RUN  v4.1.4 /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker
 Test Files  5 passed (5)
      Tests  49 passed (49)
   Duration  133ms
```

Second run (cheap determinism confidence check):

```
 Test Files  5 passed (5)
      Tests  49 passed (49)
   Duration  119ms
```

Both runs 49/49 green. No flakiness.

### Typecheck status

```
$ cd worker && npx tsc --noEmit
(no output)
```

Clean. The new exported symbols (`AccessTokenPayload`, `AccessTokenError`, `ACCESS_TOKEN_TTL_SECONDS`, `base64urlToBytes`, `signAccessToken`, `verifyAccessToken`) compile without errors. Nothing in the existing code imports them yet — that's Commit 4.

### Notes-worthy observations during implementation

- **Shape validation needed an additional pattern for nullable fields.** The `tenant_id` and `full_name` fields are `string | null`. A simple `typeof === "string"` check would reject the admin-user case (where both are null). I added explicit `null`-or-string checks using `(field === null || typeof field === "string")`. This is the only structural divergence from `activation-token.ts`'s simpler all-required-string-or-number check.
- **The `Omit<AccessTokenPayload, "iat" | "exp">` parameter type** on `signAccessToken` forces callers to supply all five user claims but prevents them from passing `iat`/`exp` (which the sign function computes internally). Cleaner TypeScript than the activation-token approach, where the caller only passed `{slug}` and everything else was internal. Possible future cleanup opportunity in activation-token.ts to use the same `Omit` pattern, but that's a refactor for another session — flagged in the found-during-reading list below.

### Commit hash

*(to be populated after git commit)*

## Commit 3 — shared CORS helper + 6 unit tests

### Files created in this commit

- `worker/src/lib/cors.ts` — shared CORS helper. Exports `ALLOWED_ORIGINS` (`ReadonlySet<string>` with 5 origins: `https://advocatemcp.com`, `https://www.advocatemcp.com`, and three localhost origins for Phase D dev), `CorsOptions` interface with an optional `credentials` boolean, and three functions: `corsHeadersFor(request, opts)` returning a plain object of CORS headers, `withCors(response, request, opts)` wrapping an existing Response with merged headers, and `handleCorsPreflight(request, opts)` returning a 204 Response for OPTIONS preflights.
- `worker/src/lib/cors.test.ts` — 6 unit tests. Pure function tests using Web API Request/Response/Headers constructors, no network, no D1, no mocks.

### Relationship to stripe.ts's existing local CORS helper

The existing CORS helper at `worker/src/routes/stripe.ts` lines 31–52 predates this commit. It has its own `ALLOWED_ORIGINS` Set (2 entries, no localhost), its own `corsHeaders(request)` function (takes no options — no credentials mode), and its own `withCors(resp, request)`, `handlePublicOnboardPreflight(request)` helpers.

**The stripe.ts local helper is deliberately left untouched in Commit 3 per the ratified Phase C scope boundary.** The new shared `cors.ts` is introduced but not wired into any endpoint yet — Commits 4 and 5 use it for the new `/api/auth/*` endpoints and the extended `/api/client/*` endpoints. The existing `/api/onboard/public` and `GET /api/onboard/session/:id` endpoints continue to call their local `withCors` and `corsHeaders` from `stripe.ts`. Zero behavioral change for any currently-working endpoint.

Migrating `stripe.ts` to use the shared helper is a future cleanup session. When that happens, the existing endpoints will need to adopt the richer `Access-Control-Allow-Headers` list from the shared helper (`Content-Type, Authorization, X-Activation-Token` instead of just `Content-Type`), which is additive and safe.

### Behavioral differences between stripe.ts's helper and the new shared helper

| Property | stripe.ts (existing) | cors.ts (new shared) |
|---|---|---|
| Allowed origins | 2 (advocatemcp.com + www) | 5 (adds 3 localhost) |
| Allow-Headers | `Content-Type` | `Content-Type, Authorization, X-Activation-Token` |
| Credentials mode | not supported (never set) | opt-in via `CorsOptions.credentials` |
| Preflight handler | `handlePublicOnboardPreflight(request)` — no options | `handleCorsPreflight(request, opts)` — options include credentials |
| `withCors` signature | `withCors(resp, request)` — two args | `withCors(response, request, opts?)` — three args with optional options |

Both helpers clone `new Headers(response.headers)` before mutating — no reference-sharing bugs in either.

### Test count delta

- Before Commit 3: 49 tests across 5 test files
- After Commit 3: 55 tests across 6 test files (+6 tests, +1 file)

### Test suite status

```
$ cd worker && npm test
 RUN  v4.1.4 /Users/cameronmcewan/Desktop/advocate/advocatemcp/worker
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  143ms
```

Second run (determinism confirmation):

```
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  126ms
```

Both runs 55/55 green. Tests are pure function tests with no time/random/external dependencies, so determinism is guaranteed by construction.

### Typecheck status

```
$ cd worker && npx tsc --noEmit
(no output)
```

Clean. The new exported symbols (`ALLOWED_ORIGINS`, `CorsOptions`, `corsHeadersFor`, `withCors`, `handleCorsPreflight`) compile without errors. Nothing in the existing code imports them yet — that's Commits 4 and 5.

### Notes-worthy observations during implementation

- **Reference-sharing protection is consistent with the existing stripe.ts pattern.** Both the old `withCors` in stripe.ts and the new `withCors` in cors.ts clone `new Headers(response.headers)` before mutating and pass the clone (not the original's headers) to `new Response(...)`. This prevents any weird mutation-through-reference bugs. Cameron's explicit heads-up in the Commit 3 prompt about this exact pattern was the right thing to flag — it would have been an easy mistake to make.
- **The `Vary: Origin` header is included in all responses** regardless of whether the origin was allowed. This is defensive cache-correctness behavior: if a cache is placed between the worker and the browser, `Vary: Origin` ensures the cache keys on the Origin header so different origins get different cached CORS responses. Omitting it would allow a cache to serve the wrong `Allow-Origin` to a second origin.
- **The `credentials` option uses explicit-true matching (`opts.credentials === true`)** rather than truthy coercion (`if (opts.credentials)`). This is defensive against string values like `"false"` accidentally coercing to truthy — the credentials header is security-critical and should only fire when the caller explicitly opts in with a boolean.

### Commit hash

*(to be populated after git commit)*

## Commit 4 — auth endpoints and refresh cookie helpers

### Files created in this commit

- `worker/src/routes/authApi.ts` — new file, ~400 lines. Exports:
  - `AuthContext` interface — flat shape with `user_id`, `email`, `full_name`, `role`, `tenant_id`, `auth_method`
  - `getSessionFromRequest(request, env)` — Bearer-first, cookie-fallback resolver (stateless on the Bearer path; DB lookup on the cookie path)
  - `handleAuthLogin(request, env)` — `POST /api/auth/login` handler with rate-limited constant-time password verification
  - `handleAuthLogout(request, env)` — `POST /api/auth/logout` handler (idempotent)
  - `handleAuthRefresh(request, env)` — `POST /api/auth/refresh` handler with create-before-delete refresh rotation
  - `handleAuthPreflight(request)` — convenience wrapper around `handleCorsPreflight` with `credentials: true` for the auth endpoints' OPTIONS preflights

### Files modified in this commit

- `worker/src/auth.ts` — appended three new exports (constants and helpers for the Phase C refresh cookie). Zero modification to the existing `sessionCookieHeader`, `clearSessionCookieHeader`, or `getSessionToken` functions — the legacy admin session cookie behavior is byte-for-byte preserved.
  - `REFRESH_COOKIE`, `REFRESH_MAX_AGE`, `REFRESH_PATH` constants (private)
  - `refreshCookieHeader(token)` — builds a `Set-Cookie` header for the refresh cookie with `HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh; Max-Age=30d`
  - `clearRefreshCookieHeader()` — builds a cookie-clearing `Set-Cookie` header with matching attributes
  - `getRefreshToken(request)` — reads the `amcp_refresh` cookie from the request

### Architectural decision: not modifying `portalDb.ts`

Per the Phase C Commit 4 constraint "Do not modify any existing function in portalDb.ts", Commit 4 does NOT touch `portalDb.ts`. Two consequences:

1. **`handleAuthLogin` does a direct D1 query for the user** (including `tenant_id`) rather than calling `getUserByEmail` from portalDb.ts. The `getUserByEmail` helper returns the existing `User` interface which doesn't include `tenant_id` (because `tenant_id` was added in Commit 1's migration and the TypeScript type in portalDb.ts wasn't extended). A small `getUserByEmailWithTenant` helper is inlined in `authApi.ts` that does the same query with an explicit column list including `tenant_id`. Small duplication, worth it to preserve the Commit 4 scope boundary.
2. **`handleAuthRefresh` uses `getSessionByToken` (which returns the existing `User` type without `tenant_id`) and then does a separate `SELECT tenant_id FROM users WHERE id = ?` query** to get the tenant_id for the new access token claims. One extra query per refresh. Cheap.

Alternatives considered:
- Extending the `User` interface in `portalDb.ts` with `tenant_id: string | null` would eliminate both workarounds but counts as touching `portalDb.ts`. Flagged as a future cleanup opportunity in the found-during-reading list below.
- Creating a parallel `CustomerUser` interface in authApi.ts would duplicate the type. Cleaner to inline the one function that needs the extra field.

### Architectural decision: cookie-path `tenant_id = null` behavior

`getSessionFromRequest`'s cookie-fallback path unconditionally sets `tenant_id = null` in the returned `AuthContext`, regardless of whether the user actually has a non-null `tenant_id` in D1. Reasoning:

- Customer users (role="client" with non-null tenant_id, created by Phase F's Stripe webhook) will always use the Bearer path. They don't have a legacy session cookie.
- Admin users (role="admin" with NULL tenant_id) are the only users who currently use the cookie path.
- Therefore, for the current and immediately-foreseeable system, `tenant_id = null` on the cookie path is correct for every user who might take that path.

If a future system state ever has customer users with legacy session cookies, the cookie path will need a separate query for `tenant_id`. Flagged in the session notes and in the file header comment.

### Critical implementation details (per Cameron's explicit guidance)

1. **Refresh rotation order: create FIRST, then delete.** `handleAuthRefresh` inlines the `INSERT INTO sessions ...` for the new refresh token BEFORE calling `deleteSession` for the old one. If the delete fails after the insert, the user has a valid new refresh cookie and the old row lingers harmlessly (it'll expire on its own). If we had done it the other way around and the insert failed after the delete, the user would be logged out with no valid cookie. Create-first is the more forgiving order.

2. **Logout is idempotent.** `handleAuthLogout` always returns `200 {ok: true}` regardless of whether the refresh cookie was present, whether the session row existed, or whether `deleteSession` succeeded. Wraps the delete in a try/catch that logs warnings but never surfaces errors to the client. This prevents information leakage about whether a session existed (which would help an attacker validate stolen cookies).

3. **Constant-time password verification on "user not found".** `handleAuthLogin` always calls `verifyPassword`, either with the real user's salt/hash or with dummy constants (`DUMMY_SALT`, `DUMMY_HASH` — 32-char and 64-char zero-filled hex strings). This keeps the total login endpoint response time roughly constant regardless of whether the email exists, preventing timing-based email enumeration. The existing legacy admin `authLogin` at `portal.ts:143-147` has this timing leak (early return on "user not found" without running `verifyPassword`). The new Phase C handler fixes it for the Phase C path — the legacy admin path still has the leak and should be hardened in a future session. Logged in the found-during-reading list below.

4. **Rate limit BEFORE any password verification.** `checkRateLimit` runs before the user lookup and before `verifyPassword`. A rate-limited email gets rejected with `429 rate_limited` without any expensive crypto or DB work. Cheap counter query, fast rejection.

### Route registration deliberately deferred to Commit 5

**Commit 4 does NOT register any routes in `portal.ts`.** The three handlers (`handleAuthLogin`, `handleAuthLogout`, `handleAuthRefresh`) plus the `handleAuthPreflight` helper are exported from `authApi.ts` but nothing imports them yet. At Commit 4's deploy, the code is live in the worker bundle but unreachable — production behavior is byte-for-byte unchanged.

Route registration happens in Commit 5 alongside the Bearer middleware wiring for the existing `/api/client/*` endpoints. Keeping both changes in one commit is intentional: Commit 5 is the one atomic change that flips production from "no cross-origin auth" to "cross-origin auth available," which is the right granularity for a behavioral change.

### Tests deferred

Per the Phase C proposal Section 7 ("skip D1 integration tests in Phase C, lean on manual E2E"), Commit 4 adds NO new unit tests. The handlers require D1 mocking infrastructure that the worker's vitest setup doesn't have. Adding that infrastructure would roughly double the Phase C diff size and introduce new testing patterns that the rest of the worker doesn't use. Matches the precedent from Phase 1.5, Phase 2, and Phase 3.

Manual E2E verification of the handlers happens after Commit 5 deploys, following the curl capture plan documented earlier in this session notes file. That verification is the sole way Commit 4's handlers are exercised at runtime — unit tests for the handlers are a future testing-infrastructure session's concern.

### Test count delta

- Before Commit 4: 55 tests across 6 files
- After Commit 4: **55 tests across 6 files (no change)**

### Test suite status

```
$ cd worker && npm test
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  140ms
```

Second run:

```
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  120ms
```

Both runs 55/55 green. No regressions from the new code.

### Typecheck status

```
$ cd worker && npx tsc --noEmit
(no output)
```

Clean. Every new import resolves, every new function signature compiles, `AuthContext` extends cleanly from the existing `SessionWithUser` field names so Commit 5's rename will be mechanical.

### Implementation bumps during execution

One drafting error caught before commit: the initial version of `handleAuthRefresh` had a nonsensical `createSession(env.DB, session.user_id).then(async () => {})` call followed by a direct `INSERT` — the `createSession` call was creating an extra untracked session row on every refresh, a DB leak. Also the initial version used `await import("../auth")` dynamic imports inside function bodies for `hashToken`, which is wrong — should be a top-level static import.

Both fixed before the test run. The final `authApi.ts` has:
- `hashToken` at the top-level static import from `../auth`
- No `createSession` usage (both login and refresh inline the `INSERT` directly because `createSession` generates its own token internally and doesn't let us supply the raw token we need to set on the response cookie)
- No dynamic imports
- `createSession` removed from the `portalDb` import list (unused)

### Commit hash

*(to be populated after git commit)*

## Commit 5 — register auth routes, apply Bearer middleware and CORS to existing endpoints

**Phase C's only commit that changes production behavior on deploy.** All prior commits (1-4 plus the Commit 0 sidetrack) shipped pure additive code that was either unreachable at runtime (Commits 2, 3, 4) or invisible to consumers (Commit 1's schema migration). Commit 5 is the one atomic change that flips the new Phase C code path from "code exists but never runs" to "code runs in production." Post-deploy, the three new auth endpoints are live and the five existing `/api/client/*` endpoints accept Bearer tokens in addition to the legacy session cookie.

### Files modified in this commit

- `worker/src/routes/portal.ts` — dispatch additions, `requireSession` docstring, migration of five handlers from `requireSession` to `getSessionFromRequest`. Details below.
- `worker/src/routes/activate.ts` — refactored `handleActivate` into an outer wrapper + inner worker pattern so CORS is applied at a single exit point via `withCors`. Details below in the "Option A vs Option B deviation" section.

### Files created in this commit

None.

### portal.ts changes

**Imports added**:
```typescript
import {
  getSessionFromRequest,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthRefresh,
  handleAuthPreflight,
} from "./authApi";
import { withCors, handleCorsPreflight } from "../lib/cors";
```

**Dispatch lines added** (inside `handlePortal`, registered alongside the existing Phase 3 activation routes):

```
/api/activate        OPTIONS → handleCorsPreflight(request)  (NEW)
/api/activate        POST    → handleActivate(request, env)  (unchanged; CORS wrapping moved into activate.ts)

/api/auth/login      OPTIONS → handleAuthPreflight(request)
/api/auth/login      POST    → handleAuthLogin(request, env)
/api/auth/logout     OPTIONS → handleAuthPreflight(request)
/api/auth/logout     POST    → handleAuthLogout(request, env)
/api/auth/refresh    OPTIONS → handleAuthPreflight(request)
/api/auth/refresh    POST    → handleAuthRefresh(request, env)

/api/client/me          OPTIONS → handleCorsPreflight(request)
/api/client/metrics     OPTIONS → handleCorsPreflight(request)
/api/client/activity    OPTIONS → handleCorsPreflight(request)
/api/client/rotate-key  OPTIONS → handleCorsPreflight(request)
```

**Eleven new dispatch lines total**: six auth endpoint lines (three OPTIONS + three POST), four OPTIONS preflight lines for the existing `/api/client/*` endpoints, and one OPTIONS line for `/api/activate`. The `/api/activate` POST dispatch stays a simple single-line dispatch — the CORS wrapping is applied inside `activate.ts` via the outer-wrapper/inner-worker pattern described below.

**`requireSession` docstring added** at line 99. Per the ratified Option C resolution of the loginPage vs `requireSession` conflict, the helper is preserved in place (unchanged body) but gets a 6-line JSDoc comment explaining why it's still there, what it's used for, when it's slated for removal, and cross-references to commit `48c5978` (Phase C Commit 4, introducing `getSessionFromRequest`) and the rearchitecture plan Section 8 Phase E.

**`requireSession` body**: unchanged. Returns `SessionWithUser | null` via `getSessionToken` + `getSessionByToken` exactly as before.

**`loginPage`**: unchanged. Still calls `requireSession`. Still has the same redirect-if-session behavior. Byte-for-byte the same code path for admins hitting `GET /login`.

**Handlers migrated from `requireSession` to `getSessionFromRequest`** (five total):

1. **`dashboard`** — uses `ctx.role` and `ctx.user_id` instead of `session.user.role` and `session.user_id`. The `buildDashboard` call previously passed `session.user` (a `User` object from `SessionWithUser`); post-migration it synthesizes a minimal `User` object from `AuthContext` fields with empty strings for the unused `password_hash`/`salt`/`created_at`/`updated_at` fields. This is safe because `buildDashboard` only reads `user.full_name` and `user.email` (verified via `grep "user\." worker/src/routes/dashboard.ts` during Commit 5 implementation — exactly two matches, both on the allowed fields). No extra D1 query, no modification to `dashboard.ts`.

2. **`apiMe`** — uses `ctx.user_id`, `ctx.email`, `ctx.full_name`, `ctx.role`. Wrapped in `withCors` without credentials mode.

3. **`apiMetrics`** — mechanical rename (ctx.role, ctx.user_id), wrapped in `withCors` at every return site.

4. **`apiActivity`** — same as apiMetrics pattern.

5. **`apiRotateKey`** — same pattern. Every return site (success, 401, 404, 502 variants) now wraps with `withCors`.

**Handlers NOT modified**:
- `authLogin` (POST /auth/login) — legacy admin form login, preserved byte-for-byte
- `authLogout` (POST /auth/logout) — legacy admin logout, preserved
- `loginPage` (GET /login) — legacy admin HTML page, preserved (still calls the preserved `requireSession`)
- `adminCreateClient` — admin-only, untouched
- `statusPage` — public status page, untouched
- Any Stripe/onboard/activate page handler

### activate.ts changes

The existing `handleActivate` function had ~13 distinct return sites (401 token errors, 400 domain errors, 409 cross-tenant, 400 mapped activate-core errors, the success path, etc.). Wrapping each individually with `withCors` would have been verbose and error-prone (missing one = silent CORS failure on one error path).

Cleaner approach: **outer wrapper + inner worker pattern**. The exported `handleActivate` becomes a thin outer wrapper that calls an unexported `handleActivateInner` function (the entire previous body of `handleActivate`) and applies `withCors` to its response at a single exit point:

```typescript
export async function handleActivate(request: Request, env: Env): Promise<Response> {
  const response = await handleActivateInner(request, env);
  return withCors(response, request);
}

async function handleActivateInner(request: Request, env: Env): Promise<Response> {
  // ... original handleActivate body, unchanged ...
}
```

Two advantages over wrapping at each return site:

1. **Single wrap point** — impossible to forget a return site. Every response from `handleActivateInner` flows through the outer wrapper.
2. **Zero modification of internal return paths** — the 13 return sites inside `handleActivateInner` are byte-for-byte the same as they were before Commit 5. The refactor is strictly additive at the outer layer.

The new import `import { withCors } from "../lib/cors";` is added to `activate.ts`. The existing `handleActivationToken` function (the admin-protected token minting endpoint) is NOT wrapped — it's called from admin tooling (curl/cli), not from the browser frontend, so it doesn't need CORS.

### Option A vs Option B deviation — surfaced before commit

**Institutional memory entry**: during Commit 5 implementation, Claude Code initially made a silent decision to wrap the `handleActivate` response with `withCors` at the `portal.ts` dispatch site instead of modifying `activate.ts` directly. The result was semantically identical (same CORS headers on the wire) but deviated from the Commit 5 prompt's explicit file list (which named `activate.ts` as one of the three files expected to change).

Claude Code caught the deviation at the pre-commit stage-and-verify step — the `git diff --cached --name-only` output showed only two files staged (`portal.ts` and the session notes), not three. Before committing, Claude Code surfaced the deviation with:

- A clear identification of which files were changed vs which were expected to change
- Two side-by-side code blocks showing the dispatch-site wrap (what was silently done) vs the internal wrap (what the spec intended)
- An explicit pros/cons comparison of both options
- A recommendation to switch to Option A for self-containment and pattern consistency with `stripe.ts`'s existing internal `withCors` pattern
- An acknowledgment that the silent choice was exactly the kind of thing the `handleAuthPreflight` rule was meant to prevent

Cameron ratified Option A. The switch was executed: `activate.ts` gained the outer/inner wrapper refactor, `portal.ts` dispatch reverted to a simple single-line call.

**Lesson re-reinforced**: "surface drift the moment it's noticed, don't bury it in a commit" — same lesson as the `handleAuthPreflight` sidetrack, caught at an earlier stage (pre-commit rather than post-commit). The discipline working correctly and catching drift earlier each time.

### Architectural decision: loginPage / requireSession conflict resolved as Option C

During Commit 5 implementation I discovered that six handlers call `requireSession`, not five — `loginPage` is the sixth. Your Commit 5 prompt said "delete `requireSession`" AND "update every handler that calls `requireSession`" AND "don't modify `loginPage`" — which was internally inconsistent given that `loginPage` calls `requireSession`.

I stopped and surfaced the conflict. You approved Option C: keep `requireSession` in place (unchanged body), update only the five API handlers to use `getSessionFromRequest`, add a docstring above `requireSession` explaining why it's preserved. `loginPage` is literally untouched.

Reasons Option C is the right resolution:

1. **Satisfies "do not modify `loginPage`" literally.** Options A, B, and D would have all touched `loginPage` in some way.
2. **The underlying consolidation goal is met** for the five handlers where Bearer capability is actually useful. `loginPage` doesn't need Bearer auth — it's an HTML page accessed by browsers via cookie-bearing navigation.
3. **Lowest-risk option for the highest-risk commit.** Commit 5 is the one commit that makes the backwards-compatibility guarantee load-bearing. Option C removes all risk from the `loginPage` code path by not touching it at all.
4. **Cosmetic concern about two helpers is addressable via Phase E.** When the legacy admin HTML pages are deprecated per the rearchitecture plan, `loginPage` and `requireSession` can be deleted together cleanly.

### Architectural decision: buildDashboard user synthesis

The `dashboard` handler previously called `buildDashboard(session.user, ...)` passing the `User` object from the `SessionWithUser` return of `requireSession`. After the migration to `getSessionFromRequest`, `AuthContext` is a flat shape without a `.user` field. Three options were considered:

A) Synthesize a minimal `User` object from `AuthContext` fields for the `buildDashboard` call — empty strings for unused fields.
B) Do a separate `getUserById(env.DB, ctx.user_id)` query to fetch the full User row.
C) Modify `buildDashboard`'s signature to accept `AuthContext` (dashboard.ts modification — off-limits).

**Option A chosen** because a grep of `dashboard.ts` during implementation showed only two accesses to the `user` parameter: `user.full_name` (line 189) and `user.email` (lines 189, 540). Both fields are in `AuthContext` directly. The synthesized `User` with empty-string placeholders for the unused four fields compiles cleanly and produces byte-identical HTML output compared to the pre-Commit-5 `session.user` pass-through. No extra DB query, no modification to `dashboard.ts`. Option B would have added an unnecessary query on every dashboard page load; Option C would have violated the constraint.

### What this commit does NOT change

- **`worker/src/auth.ts`** — not modified (refresh cookie helpers were added in Commit 4)
- **`worker/src/portalDb.ts`** — not modified (existing functions preserved)
- **`worker/src/routes/authApi.ts`** — not modified (all handlers were built in Commit 4)
- **`worker/src/routes/dashboard.ts`** — not modified (the HTML renderer)
- **`worker/src/routes/activate.ts`'s `handleActivateInner` body** — not modified. The outer `handleActivate` wrapper is new in Commit 5 and applies CORS at a single exit point, but the business logic of the activation flow is byte-for-byte the same as it was in Phase 3 Commit `c6042ba`. The 13 return sites inside `handleActivateInner` are untouched.
- **`worker/src/routes/activate.ts`'s `handleActivationToken` function** — not modified. It's called from admin tooling only and doesn't need CORS.
- **`worker/src/routes/stripe.ts`** — not modified (its local CORS helper still serves `/api/onboard/public`)
- **All legacy admin handlers** — `authLogin`, `authLogout`, `loginPage`, `adminCreateClient`, `statusPage` — byte-for-byte preserved

### Backwards compatibility guarantee — what a browser with an `amcp_session` cookie experiences post-Commit-5

Three specific guarantees from the Phase C proposal Section 6:

1. **`POST /auth/login` (admin form)** — unchanged. Same form submission, same validation, same 302 redirect to `/dashboard` with `Set-Cookie: amcp_session=...`. `authLogin` function body is byte-for-byte identical.

2. **`GET /dashboard` with `amcp_session` cookie** — still renders the admin dashboard HTML. The handler's body was modified, but the cookie-bearing request flow is:
   `getSessionFromRequest` → no Bearer header → cookie fallback → `getSessionByToken` → returns `SessionWithUser` → helper translates to `AuthContext` with `tenant_id: null` → handler continues with `ctx.role` (which is `"admin"` for admins) → fetches businesses → renders `buildDashboard` with the synthesized `User`. Result: byte-identical HTML because `buildDashboard` reads the same two fields (`email`, `full_name`) and those fields carry the same values in the synthesized User as they did in the original `session.user`.

3. **All five `/api/client/*` endpoints with `amcp_session` cookie** — still return 200 JSON. The cookie-fallback path in `getSessionFromRequest` replicates the pre-Commit-5 `requireSession` behavior exactly. The additional CORS headers wrapping the response are harmless for same-origin requests — the browser receives them but doesn't use them. No cookie-bearing request is rejected.

### Manual E2E verification plan (after push + 30s propagation)

Claude Code pauses after push. Cameron runs the five-step verification manually:

1. Visit `https://customers.advocatemcp.com/login` in a browser. Submit valid admin credentials via the form.
2. Verify redirect to `/dashboard` with the existing admin dashboard HTML rendering correctly.
3. Run `curl -v -b "amcp_session=<cookie-from-step-2>" https://customers.advocatemcp.com/api/client/me` → expect 200 JSON with user info.
4. Run `curl -v -X OPTIONS -H "Origin: https://advocatemcp.com" -H "Access-Control-Request-Method: POST" https://customers.advocatemcp.com/api/auth/login` → expect 204 with `Access-Control-Allow-Origin: https://advocatemcp.com` and `Access-Control-Allow-Credentials: true`.
5. Run `curl -v -X POST -H "Content-Type: application/json" -d '{"email":"nosuchuser@example.com","password":"wrong"}' https://customers.advocatemcp.com/api/auth/login` → expect 401 with `{"ok": false, "error_code": "invalid_credentials"}`.

Claude Code does NOT attempt these verifications — steps 1-3 require browser cookie handling that curl-from-context can't do cleanly, and step 5 would trigger rate limiting if run repeatedly.

### Test suite status

```
$ cd worker && npm test
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  151ms
```

Second run:

```
 Test Files  6 passed (6)
      Tests  55 passed (55)
   Duration  131ms
```

Both runs 55/55 green. No regressions from the portal.ts modifications.

### Typecheck status

```
$ cd worker && npx tsc --noEmit
(no output)
```

Clean. The synthesized `User` object in the dashboard handler compiles, the migration from `requireSession` to `getSessionFromRequest` type-checks in all five handlers, and the new dispatch lines all resolve their imports correctly.

### Commit hash

*(to be populated after git commit)*

## Found during reading — not in Phase C scope

Items noticed while reading the codebase for Phase C's proposal that do not belong to Phase C. Logged here for future sessions. None of these are fixed or touched in Phase C.

- **`worker/src/lib/tracked-url.test.ts` may have the same base64-padding flakiness bug as Phase 3's `activation-token.test.ts` had.** The tracked-url test suite from Phase 1 uses a similar "tamper with a character" pattern and may be vulnerable to the same padding-bit issue fixed in commit `63f1e30`. Should be audited in a future session using the same diagnostic reasoning — check whether any test modifies the last character of a base64url-encoded fixed-length signature and assumes the tamper breaks decoding. If so, apply the middle-character-modification pattern from `activation-token.test.ts` as fixed.

- **`worker/src/routes/onboard.ts` contains five admin-auth'd legacy handlers** (`handleOnboard`, `handleOnboardStatus`, `handleVerifyDomain`, `handleOnboardList`, `handleVerifyAll`, `handleDisableTenant`) whose relationship to the `handleBasicOnboard`/`handlePublicOnboard` endpoints in `stripe.ts` is unclear from reading alone. Flagged in the earlier Phase C audit as "canonical vs legacy unclear." Not in Phase C scope to sort out — belongs in a dedicated cleanup session after Phase E (worker HTML deprecation).

- **`worker/src/routes/portal.ts:99` has a `requireSession` helper that will be deleted during Commit 5** as part of replacing cookie-only auth with `getSessionFromRequest`. This is expected Phase C scope, not a found-during-reading item — noted here only because I noticed it during the proposal reading pass and want the explicit handoff recorded.

- **`worker/src/lib/activation-token.ts`'s `signActivationToken` function takes `payload: { slug: string }` as its parameter type** rather than `Omit<ActivationTokenPayload, "iat" | "exp">`. The `Omit` pattern is cleaner — it future-proofs against adding new required payload fields (the type system would then force callers to supply them) and prevents callers from accidentally passing `iat`/`exp` explicitly. Commit 2's `signAccessToken` uses the `Omit` pattern. A future cleanup session could refactor `activation-token.ts` to match. Low-priority, test-only impact, and the current activation-token code works correctly — this is purely a type-level cleanup opportunity, not a bug.

- **`worker/src/routes/portal.ts:143-147` — the existing legacy `authLogin` has a timing-based email enumeration leak.** When the posted email is not found in the users table, the function returns immediately without running `verifyPassword`. An attacker can distinguish "user exists, wrong password" (~100k PBKDF2 iterations ≈ 100–200 ms) from "user doesn't exist" (≈5 ms) and enumerate valid emails by measuring response time. The new Phase C `handleAuthLogin` in `authApi.ts` fixes this for the new path by always running `verifyPassword` against either the real user's salt/hash or dummy constants. The legacy admin `authLogin` should get the same fix in a future session — tiny diff, same pattern. Flagged for a dedicated admin-login-hardening session (not Phase C scope).

- **`worker/src/portalDb.ts`'s `User` interface does not include the `tenant_id` column** even though Commit 1's migration added it to the D1 schema. `getUserByEmail` does `SELECT * FROM users` which returns `tenant_id` in the row data, but the TypeScript type narrowing via `.first<User>()` drops the field because it's not declared in the interface. Consequence: Commit 4's `authApi.ts` had to inline a separate `getUserByEmailWithTenant` helper and a separate `SELECT tenant_id FROM users WHERE id = ?` query in `handleAuthRefresh` to access the field. A future cleanup session should extend the `User` interface with `tenant_id: string | null`, update `getSessionByToken` to include `tenant_id` in its SELECT, and let `authApi.ts` drop its inline helper + extra query. Low-priority, type-system cleanup, no runtime impact beyond one extra query per refresh call.

---

## Observed log output and curl captures

*(to be populated after Commit 5 deploys and the manual E2E verification runs)*

---

## Residual concerns and followup items for after Phase C

*(to be populated at Commit 6)*
