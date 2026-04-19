# Secrets Runbook

This file inventories every production secret AdvocateMCP depends on, where
each lives, how to rotate each, and what breaks if it's missing or drifts.

Last audited: 2026-04-19.

---

## TL;DR

Two systems hold secrets:

1. **Cloudflare Worker** (`worker/`) — secrets set via
   `cd worker && npx wrangler secret put <NAME>`
2. **Railway server** (`server/`) — env vars set in the Railway dashboard
   (project → Variables)

Three secrets MUST match across both systems — see [Shared
secrets](#shared-secrets) below. Update both in the same session or things
drift silently until the bad code path is exercised.

---

## Worker secrets (`wrangler secret put` from `worker/`)

> **Critical**: always run `wrangler` commands from `worker/`, not from the
> repo root. See `worker/CLAUDE.md` for the stale `wrangler.toml` hazard.

### Auth & signing

| Secret | Purpose | Breakage on missing |
|---|---|---|
| `ACCESS_TOKEN_SIGNING_KEY` | HMAC-SHA256 for 15-min Bearer access tokens (Phase C auth) | `/api/auth/login` and `/api/auth/refresh` return 500 |
| `ACTIVATION_SIGNING_KEY` | HMAC-SHA256 for self-serve activation tokens (Phase F) | `/api/activate` and `/admin/activation-token` fail |
| `TOKEN_SIGNING_KEY` | **SHARED** — HMAC for attribution tokens (`/track` redirect) | Attribution tokens fail verification silently — clicks not tracked |
| `ADMIN_SECRET` | Bearer token for `/admin/*` endpoints | 401 on every admin endpoint |

### External APIs

| Secret | Purpose | Breakage on missing |
|---|---|---|
| `API_KEY` | **SHARED** — `X-API-Key` used on worker→server calls | Worker→Railway calls 401; dashboard metrics empty |
| `API_BASE_URL` | Railway backend URL | Optional — defaults to `advocate-production-2887.up.railway.app` |
| `RESEND_API_KEY` | **SHARED** — Resend email API | Activation emails fail (worker side) |
| `CF_API_TOKEN` | Cloudflare API token (`custom_hostnames:edit`, `zone:read`, `workers_routes:edit`) | Domain onboarding fails; `/admin/domains/ensure-worker-route` fails |
| `CF_ZONE_ID` | Zone ID for `advocatemcp.com` | Domain ops return 500 |

### Stripe (all mode-specific — all four must be in the same mode)

| Secret | Purpose | Breakage on missing |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` or `sk_live_...` | Checkout session creation fails |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` — webhook signature HMAC | `/api/stripe/webhook` returns 400 on every delivery |
| `STRIPE_PRICE_ID_BASE` | Price ID for $100/mo plan | Base-tier checkout returns 500 `stripe_price_missing` |
| `STRIPE_PRICE_ID_PRO` | Price ID for $250/mo plan | Pro-tier checkout returns 500 |

**Mixing modes (e.g. `sk_live_` with a test-mode `STRIPE_PRICE_ID_*`) produces
400 "No such price" errors from Stripe.** To verify which mode is loaded at
runtime, hit `POST /api/onboard/public` and watch `wrangler tail` — the
`stripe_key_probe` log line prints the first 12 chars of each secret.

---

## Railway server env vars (set in Railway dashboard → Variables)

### Required for startup

| Var | Purpose | Breakage on missing |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key | Server exits on boot |

### Shared with Worker

| Var | Purpose |
|---|---|
| `API_KEY` | **MUST MATCH** worker's `API_KEY` |
| `TOKEN_SIGNING_KEY` | **MUST MATCH** worker's `TOKEN_SIGNING_KEY` |
| `RESEND_API_KEY` | **MUST MATCH** worker's `RESEND_API_KEY` |

### Competitor Radar polling

| Var | Purpose | Default |
|---|---|---|
| `PERPLEXITY_API_KEY` | Perplexity citation polling | — (cron silent if missing) |
| `OPENAI_API_KEY` | OpenAI citation polling (P3 v1.1) | — |
| `POLL_SCHEDULE_CRON` | Radar cron | `0 4 * * 1,3,5` (Mon/Wed/Fri 04:00 UTC) |
| `PERPLEXITY_DAILY_BUDGET_USD` | Per-provider budget cap | `10` |
| `OPENAI_DAILY_BUDGET_USD` | Per-provider budget cap | `10` |

### Weekly digest (P5)

| Var | Purpose | Default |
|---|---|---|
| `DIGEST_SCHEDULE_CRON` | Weekly send | `0 14 * * 1` (Mon 14:00 UTC) |
| `DIGEST_RETRY_SCHEDULE_CRON` | Retry sweep (Phase F Part 3) | `*/2 * * * *` |
| `DIGEST_EMAIL_FROM` | Sender address | `radar@advocatemcp.com` |
| `DASHBOARD_URL` | Link target in digest | `https://customers.advocatemcp.com/dashboard` |
| `UNSUBSCRIBE_URL_BASE` | Unsubscribe link base | Railway default URL |

### Audit funnel

| Var | Purpose | Default |
|---|---|---|
| `AUDIT_IP_SALT` | SHA-256 salt for IP hashing on `public_audits` | `"dev-audit-ip-salt"` (insecure in prod — set a real value) |
| `ADMIN_API_KEY` | Bearer token for `/admin/audits/*` endpoints | — (endpoints return 401 if missing) |

---

## Shared secrets — rotation protocol

These three secrets exist on BOTH systems. Unilateral rotation creates drift
that's silent until the affected code path fires.

| Secret | Worker | Railway | Mode-specific |
|---|---|---|---|
| `API_KEY` | `wrangler secret put` | Railway env | No |
| `TOKEN_SIGNING_KEY` | `wrangler secret put` | Railway env | No |
| `RESEND_API_KEY` | `wrangler secret put` | Railway env | No |

**Atomic rotation procedure:**

1. Generate the new value: `openssl rand -hex 32` (for signing keys) or via
   the provider dashboard (Resend).
2. Paste the new value in Railway → Variables. **Do NOT hit "Deploy" yet** —
   Railway will auto-redeploy on save, which is fine for a one-sided var,
   but for shared secrets we want both sides to flip in tight sequence.
3. Flip the worker side: `cd worker && echo "$NEW_VALUE" | npx wrangler secret put <NAME>`.
4. Trigger a worker deploy (wrangler does this automatically after
   `secret put`).
5. Wait for both to settle (~30s), then smoke-test:
   - `API_KEY` — load the dashboard; metrics panel should populate.
   - `TOKEN_SIGNING_KEY` — click an attribution link; `/track` should 302.
   - `RESEND_API_KEY` — trigger an activation email or a digest smoke-test.

---

## Per-secret rotation steps

### Stripe

1. Stripe dashboard → Developers → API keys → create new secret key (or
   rotate existing).
2. Update `STRIPE_SECRET_KEY` via `wrangler secret put` from `worker/`.
3. If the rotation also created a new webhook signing secret, update
   `STRIPE_WEBHOOK_SECRET`. Otherwise it stays the same.
4. Smoke test: run a test-mode checkout with `POST /api/onboard/public` and
   verify the redirect returns a valid `session_id` and the webhook fires.

**Price IDs rarely rotate** — only if you change the subscription product.
Mode-specific (test price IDs ≠ live price IDs). Mixing modes causes 400s.

### Cloudflare API token

1. Cloudflare dashboard → My Profile → API Tokens → edit token "Advocate
   0.1" (or create new).
2. Required scopes: `Workers Routes: Edit`, `Custom Hostnames: Edit`,
   `Zone: Read` — all on the `advocatemcp.com` zone.
3. `cd worker && npx wrangler secret put CF_API_TOKEN`, paste new value.
4. Smoke test: `curl -X POST https://customers.advocatemcp.com/admin/domains/ensure-worker-route
    -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json"
    -d '{"hostname":"www.workmancopyco.com"}'` should return 200.

### Admin secret

1. Generate: `openssl rand -hex 32`.
2. `cd worker && npx wrangler secret put ADMIN_SECRET`.
3. Propagate to ops (1Password, team notes, wherever the canonical copy
   lives).
4. Any existing curl invocations using the old secret will 401 — update
   them.

### Resend key

1. Resend dashboard → API Keys → rotate.
2. Update BOTH worker and Railway (shared).
3. Smoke test: trigger an activation email or a `POST /admin/digest/send-now`
   dry run (if the smoke endpoint exists; otherwise wait for next cron).

---

## When a secret leaks (incident procedure)

1. **Stop the bleeding** — rotate immediately, don't wait for the weekly
   rotation window.
2. **Audit reach** — check CF audit logs, Stripe event logs, Resend send
   logs for the time window the secret was exposed.
3. **If Stripe leaked** — check the Stripe dashboard for anomalous API
   calls; rotate the webhook secret too (separate rotation from the API
   key).
4. **If a signing key leaked (TOKEN_SIGNING_KEY / ACCESS_TOKEN_SIGNING_KEY
   / ACTIVATION_SIGNING_KEY)** — every token signed with the old key is
   now forgeable. Rotation invalidates them all; this means:
   - Users get re-prompted to log in (ACCESS_TOKEN).
   - Pending activation emails' links break (ACTIVATION).
   - In-flight `/track` redirects with the old-key token 401 (TOKEN).
5. **Document the incident** — date, which secret, how it leaked, what was
   rotated. Add to `docs/incidents/YYYY-MM-DD-<name>.md`.

### Known incident (2026-04-12)

`STRIPE_WEBHOOK_SECRET` was accidentally `printf`'d in a shell during
debugging. Was rotated via Stripe dashboard + `wrangler secret put` on
2026-04-12 evening. Watch for 401s on any in-flight webhook retries from
that window — see `docs/followups.md`.
