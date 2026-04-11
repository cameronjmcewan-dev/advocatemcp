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
| 3 | Shared CORS helper + unit tests | *(in progress)* | — |
| 4 | Auth endpoints (login, logout, refresh) + cookie helpers + middleware | not started | — |
| 5 | Bearer middleware applied to existing endpoints + CORS dispatch lines | not started | — |
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

## Found during reading — not in Phase C scope

Items noticed while reading the codebase for Phase C's proposal that do not belong to Phase C. Logged here for future sessions. None of these are fixed or touched in Phase C.

- **`worker/src/lib/tracked-url.test.ts` may have the same base64-padding flakiness bug as Phase 3's `activation-token.test.ts` had.** The tracked-url test suite from Phase 1 uses a similar "tamper with a character" pattern and may be vulnerable to the same padding-bit issue fixed in commit `63f1e30`. Should be audited in a future session using the same diagnostic reasoning — check whether any test modifies the last character of a base64url-encoded fixed-length signature and assumes the tamper breaks decoding. If so, apply the middle-character-modification pattern from `activation-token.test.ts` as fixed.

- **`worker/src/routes/onboard.ts` contains five admin-auth'd legacy handlers** (`handleOnboard`, `handleOnboardStatus`, `handleVerifyDomain`, `handleOnboardList`, `handleVerifyAll`, `handleDisableTenant`) whose relationship to the `handleBasicOnboard`/`handlePublicOnboard` endpoints in `stripe.ts` is unclear from reading alone. Flagged in the earlier Phase C audit as "canonical vs legacy unclear." Not in Phase C scope to sort out — belongs in a dedicated cleanup session after Phase E (worker HTML deprecation).

- **`worker/src/routes/portal.ts:99` has a `requireSession` helper that will be deleted during Commit 5** as part of replacing cookie-only auth with `getSessionFromRequest`. This is expected Phase C scope, not a found-during-reading item — noted here only because I noticed it during the proposal reading pass and want the explicit handoff recorded.

- **`worker/src/lib/activation-token.ts`'s `signActivationToken` function takes `payload: { slug: string }` as its parameter type** rather than `Omit<ActivationTokenPayload, "iat" | "exp">`. The `Omit` pattern is cleaner — it future-proofs against adding new required payload fields (the type system would then force callers to supply them) and prevents callers from accidentally passing `iat`/`exp` explicitly. Commit 2's `signAccessToken` uses the `Omit` pattern. A future cleanup session could refactor `activation-token.ts` to match. Low-priority, test-only impact, and the current activation-token code works correctly — this is purely a type-level cleanup opportunity, not a bug.

---

## Observed log output and curl captures

*(to be populated after Commit 5 deploys and the manual E2E verification runs)*

---

## Residual concerns and followup items for after Phase C

*(to be populated at Commit 6)*
