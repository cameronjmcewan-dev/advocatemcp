# Activation flow: capture password at signup, gate dashboard on email verification

**Status:** approved 2026-05-02
**Owner:** Cameron McEwan
**Driver:** Customer reported "I shouldn't have to set a new password — I already did that during signup" on hosted-tenant activation.

## Problem

Hosted-tenant signup collects an email and password on `site/onboarding.html`, but the password is **not** sent to the worker — `buildOnboardPayload()` at line 2155 builds an `outer` object with `email` only. The password input is validated client-side and discarded.

After payment, the customer receives an activation email pointing at `/activate?t=<token>`. The worker's `renderHostedPage()` in `worker/src/routes/activatePage.ts` then asks them to "Set your password" again. From the customer's POV, this is a duplicate credential ask.

The fix needs to (a) actually persist the signup-form password, (b) make the activation step a one-click email confirmation that auto-logs them into the dashboard, (c) preserve cross-device behavior (signup on laptop, click email on phone), and (d) ship safely after a recent prod-down from a bad migration.

## Approved approach

**A: User record + session at signup, verify-email gates dashboard.**

Signup creates the `users` row, hashes the password, mints a session, and returns the Stripe checkout URL. The activation token's only job is to flip `email_verified=0 → 1` and mint a fresh session in whatever browser opens it. Dashboard middleware enforces `email_verified=1` — a 403 response triggers a "check your inbox" splash, not a re-credentialing flow.

Why A and not the alternatives:
- **B (no session until email verified)** — worse UX (Stripe redirect can't greet by name; if email is delayed they're stuck) for marginal extra security on a path already gated by Stripe payment.
- **C (defer user creation until activation, store in `pending_signups`)** — cleaner orphan-user model but adds a new table, two write paths, and a password hash for an unverified email in a more obscure place.

## Data flow

```
[Browser]                  [Worker]                  [Stripe]

POST /api/onboard/public
{email, password, ...}
─────────────────────────►
                          hashPassword (PBKDF2,
                            via authApi.ts)
                          INSERT users row
                            email_verified = 0
                          INSERT businesses row
                          INSERT user_business_access
                          createSession + cookie
                          stripe.checkout.create
                          ─────────────────────────►
Set-Cookie: amcp_refresh
{checkout_url}
◄─────────────────────────
redirect → Stripe

──── customer pays ──────────────────────────────►
                          Stripe webhook
                          ◄─────────────────────────
                          sendActivationEmail
                          (existing flow, untouched)

GET /activate?t=...
─────────────────────────►
                          verify HMAC token
                          if user has password_hash:
                            UPDATE users SET email_verified=1
                            createSession
                            302 → /dashboard
                          else (legacy):
                            render password-set form
                            (existing handleActivateHosted)
Set-Cookie + 302
◄─────────────────────────

GET /dashboard
─────────────────────────►
                          requireSession + email_verified=1
                          if email_verified=0:
                            403 { error_code: "email_unverified" }
                            client renders "check your inbox" splash
                            with "resend email" button
dashboard + tutorial
◄─────────────────────────
```

## Schema change

`worker/migrations/0014_users_email_verified.sql`:

```sql
ALTER TABLE users
  ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE users SET email_verified = 1
WHERE id IN (
  SELECT DISTINCT uba.user_id
  FROM user_business_access uba
  JOIN businesses b ON b.id = uba.business_id
  WHERE b.stripe_subscription_id IS NOT NULL
);
```

The backfill marks every currently-paying customer's user as verified, so existing logins don't break. New post-fix signups land at `email_verified=0` and clear it via the activation click.

## Components by file

| File | Change | WIP collision |
|---|---|---|
| `worker/migrations/0014_users_email_verified.sql` | new | none |
| `site/onboarding.html` | add `password` field to the `outer` payload at line ~2161 | clean |
| `worker/src/routes/onboard.ts` (locate `handlePublicOnboard`) | extend zod input schema with `password` (8–256 chars), hash via existing helpers, create user + link + mint session before returning checkout URL | clean |
| `worker/src/routes/activate.ts` (`handleActivateHosted`) | branch: if user has `password_hash`, skip password ask + flip `email_verified=1`; else fall through to existing password-set path (legacy customers) | **collision with WIP — do in worktree, rebase WIP on top at merge time** |
| `worker/src/routes/activatePage.ts` (`renderHostedPage`) | render a single "Confirm and continue" button when the lookup shows the user has a password; preserve the password-set form for the legacy branch | clean |
| `worker/src/routes/authApi.ts` (`getSessionFromRequest`) | extend to load `email_verified`; callers in `worker/src/routes/portal.ts` (dashboard route + `/api/client/*` handlers) check the flag and return 403 + `error_code: "email_unverified"` when `0` | clean |
| `site/dashboard.html` (or `assets/dashboard-chrome.js`) | render "check your inbox" splash with resend button on 403 + `error_code: "email_unverified"` | clean |

## Error handling

- **Signup with already-registered email:** `INSERT users` fails on unique constraint. Worker returns 409 with `error_code: "email_taken"`; onboarding page surfaces "this email already has an account — log in instead".
- **Signup password too short:** zod schema rejects with 400 + per-field error, mirrored in onboarding's existing inline-error pattern.
- **Activation token expired:** existing 401 path. Page shows "your link expired — check your email for a fresh one or contact support".
- **Stripe webhook never fires (payment lost):** customer has logged-in account with `email_verified=0` and no business subscription. Dashboard splash says "your payment didn't complete — restart checkout". No data loss.
- **User clicks email twice:** second click is idempotent — `UPDATE users SET email_verified=1` is a no-op, fresh session minted, redirect.
- **Cross-device:** activation token mints a fresh session cookie in the browser that opened it. The original signup-device session keeps working too (sessions are per-cookie, not per-user-singleton).

## Testing strategy

1. **Unit — worker:**
   - `handleActivateHosted` with existing user (skip password) and without user (legacy fallback)
   - email-verification middleware: 403 when 0, pass-through when 1
   - `handlePublicOnboard` payload schema accepts password, rejects <8-char
2. **Integration:**
   - smoke-test.sh extension: register tenant, simulate webhook, hit /activate, confirm session + `email_verified=1`
   - dashboard hit returns 403 + email_unverified before activation, 200 after
3. **Manual dry-run:** create a throwaway `smoke-test-NN` slug, walk the full flow with a real Stripe test-mode card, verify on a second browser (cross-device click).

## Migration safety + rollout

We just lived through a prod-down on `server/src/db/migrations/038_*.sql` because the SQLite migration runner crashed at boot. **D1 migrations are different** — they run via `wrangler d1 migrations apply --remote`, an explicit manual step, not auto-applied at worker boot. So a bad D1 migration doesn't crash the worker.

Order:
1. Write code in worktree, run unit tests locally.
2. Apply migration: `cd worker && npx wrangler d1 migrations apply advocatemcp-auth --remote`. Verify with `wrangler d1 execute advocatemcp-auth --remote --command "SELECT email_verified FROM users LIMIT 5"`.
3. `wrangler deploy` the worker. Smoke-test against the deployed Worker.
4. Push to `main` → Pages picks up the onboarding/dashboard HTML changes.
5. Manual dry-run on `smoke-test-NN` before announcing.

**Rollback:**
- Code: `wrangler rollback` reverts to the prior worker version. Pages site reverts via `wrangler pages deployment retire` (or git revert + push).
- Schema: column stays. `DEFAULT 0` is harmless. If we need to undo the backfill, it's idempotent — re-running the UPDATE doesn't double-mark anything.

## Out of scope

- DNS-based tenants (custom domain): activation flow there is about DNS records, not credentials. Their password handling is a separate beast and not affected.
- Password reset / "forgot password" flow: existing or absent, not changed here.
- Email-verification expiry / re-verify cadence: `email_verified` is a one-way bit. We don't re-prompt after, say, 90 days.
- Team-invite magic links (`/auth/team-accept`): separate flow, untouched.
