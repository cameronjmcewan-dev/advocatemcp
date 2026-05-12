# Security Controls Reference

**Last reviewed:** 2026-05-12.
**Scope:** Documented justification for security controls (and known gaps)
on the AdvocateMCP hosted service, framed around SOC 2 Common Criteria.

This document is what the auditor reads first. It is not a marketing
artifact — it is the rationale, in writing, for every control choice
that wouldn't be obvious from the code.

## Data classification

| Class | Examples in AdvocateMCP | Storage | Retention |
|-------|------------------------|---------|-----------|
| **Secrets** | Stripe keys, HMAC signing keys, admin secret, Anthropic API key, Twilio creds, Resend API key | Cloudflare Workers secrets + Railway env vars | Indefinite while in use; rotation log in `docs/secrets-runbook.md` |
| **Credentials (per-user)** | Password hashes (PBKDF2-SHA256), TOTP secrets, refresh tokens | D1 `users` table | Lifetime of the account + 30 days post-deletion |
| **API keys (per-tenant)** | `businesses.api_key` hashed since migration 039 (SOC 2 C1) | Server SQLite (Railway), mirrored on D1 (Worker, used only for portal display) | Lifetime of the subscription; revoked on cancellation per migration 0026 + 038 |
| **PII (reservation/handoff contact)** | `customer_contact_json` on reservations, `contact_email`/`contact_phone` on callbacks, `lead_routing_json` on businesses | Server SQLite | 24h held → 7d expired → 90d confirmed → redacted in place (see `server/src/jobs/expirySweeper.ts`) |
| **Operational data** | Queries, click events, audit_events, profile blobs | D1 + Server SQLite | Indefinite by default; audit_events explicitly retained for SOC 2 evidence |
| **Public** | Marketing site content, MCP manifest, attribution-token tracked URLs | Pages, public CDN | n/a |

## Encryption in transit

| Surface | Mechanism | Notes |
|---------|-----------|-------|
| `customers.advocatemcp.com` (Worker) | HTTPS only, min TLS 1.2 | Cloudflare-managed cert |
| `*.hosted.advocatemcp.com` (custom hostnames) | HTTPS only, min TLS 1.2 | Cloudflare-managed cert per hostname; min_tls_version pinned in `worker/src/lib/hostnameSpec.ts` |
| `api.advocatemcp.com` (Railway) | HTTPS only | Railway-managed cert |
| `advocatemcp.com` (Pages) | HTTPS only | Cloudflare-managed cert |
| Worker → Railway hop | HTTPS via `API_BASE_URL` env | No inter-service HTTP fetch in production |

## Encryption at rest

| Store | At-rest control | Justification |
|-------|----------------|---------------|
| Cloudflare D1 | Encrypted by Cloudflare (their SOC 2 covers it) | We rely on the sub-processor control; cited in `docs/vendor-management.md` |
| Cloudflare KV | Same as D1 | Same |
| Railway volume (SQLite) | Disk-level encryption per Railway's platform docs | Verify each quarterly review; we have no application-layer envelope encryption — see "Known gaps" below |
| Cloudflare R2 (backups, future) | Server-side encryption with provider-managed keys | Standard for R2 |

### Plaintext columns — why

Some columns store sensitive-but-not-secret data in plaintext at the
application layer. This is deliberate; each is justified below.

- **`businesses.api_key` (plaintext column, still present)** — DEPRECATED.
  Retained during the dual-read transition introduced by migration 039.
  New rows write to `api_key_hash` (PBKDF2-SHA256, 100k iter); legacy
  rows are backfilled on first authentication. After observation
  confirms `api_key_hash IS NOT NULL` on all rows, migration 040 will
  drop the plaintext column. See `server/src/middleware/auth.ts`
  resolveBusinessByApiKey for the lookup path.
- **`businesses.api_key` (worker D1 copy)** — used only for portal
  display, never for an auth decision. The customer can view their key
  in the dashboard so they can configure clients. SOC 2-defensible
  because (a) D1 is encrypted at rest by Cloudflare, (b) the value is
  rotatable via `POST /admin/onboard/rotate-railway-key`, (c) it is
  never used for an auth gate on the worker side — auth decisions
  happen on Railway, which now uses the hashed version.
- **`users.totp_secret`** — TOTP shared secret. Standard practice is to
  store this plaintext at the application layer; the alternative
  (envelope encryption with a KMS-held wrapping key) is in scope for a
  future hardening pass but not v1. The secret is not by itself an
  authentication credential — possession plus the ability to derive the
  current 6-digit code at sign-in time is what authenticates.
- **PII columns (`customer_contact_json` etc.)** — plaintext at the app
  layer because (a) the redaction policy auto-destroys after
  24h/7d/90d, (b) the data is needed in cleartext at the reservation
  fulfillment moment, (c) the DB is encrypted at rest and not
  internet-exposed. This trade-off is documented in `AGENTS.md` Session
  9 PII retention notes.

## Authentication

| Surface | First factor | Second factor | Reference |
|---------|-------------|---------------|-----------|
| Customer portal / admin dashboard login | Email + password (PBKDF2-SHA256, 100k iter) | TOTP (RFC 6238, SHA-1, 30s, 6 digits) when enrolled — required at login, not optional | `worker/src/auth.ts`, `worker/src/lib/totp.ts` |
| MCP API per-tenant | Bearer API key (hashed, PBKDF2-SHA256, prefix lookup + constant-time verify) | None | `server/src/middleware/auth.ts` |
| Server-to-server (worker → Railway) | Shared secret `API_KEY` via `X-API-Key` header | None | Same |
| Stripe webhook | HMAC-SHA256 signature verification with dual-secret rotation | None | `worker/src/routes/stripe.ts` |
| Attribution / continuation tokens | HMAC-SHA256 with `TOKEN_SIGNING_KEY` + per-purpose domain separation prefix | None — these are bearer tokens by design | `server/src/lib/continuationToken.ts`, `server/src/lib/tracked-url.ts` |

## Authorization

- Tenant API keys are scoped: `requireSlugApiKey` and
  `requireSlugOrAdminKey` both verify that the matched row's slug equals
  the URL `:slug` after the key matches. Cross-tenant access via a leaked
  key for a different tenant is rejected.
- `requireServerKeyOnly` accepts ONLY the worker→Railway shared secret;
  tenant keys cannot reach expensive admin endpoints (Claude-backed
  profile-score / format-judge) even via direct curl to Railway.
- Admin role is gated by `users.role = 'admin'`; checked server-side in
  every `/admin/*` route handler.

## Logging & monitoring

- Sentry on both Worker (via `@sentry/cloudflare`) and Server (via
  `@sentry/node`). DSNs configured per environment.
- Cloudflare Observability enabled for the Worker.
- Audit-event log: `audit_events` table in D1 (migration 0025). Wired
  call sites: login success/failure/logout, TOTP enroll/disable/login
  events, Stripe lifecycle, tenant API key issuance.
- **No alerting rules yet** — flagged as gap M2 in
  `docs/soc2-gap-assessment.md`.

## Change management

- Every commit on `main` is via a PR; CI gates on
  `.github/workflows/server-ci.yml` (typecheck + tests + boot smoke + npm
  audit advisory) and `.github/workflows/deploy-worker.yml`.
- Local pre-commit hook at `scripts/git-hooks/pre-commit` runs secret
  scan + typecheck + migration filename check. Install with
  `scripts/install-git-hooks.sh`.
- Migrations are NNN-prefixed, applied in filename order, idempotent in
  the schema-migrations runner.
- Staging worker (per `.github/workflows/deploy-worker-staging.yml`)
  deploys PRs to `staging-customers.advocatemcp.com` once one-time CF
  setup is complete. Until then, the workflow no-ops with a warning.

## Vendor controls (sub-processors)

See `docs/vendor-management.md` for the full list. Every sub-processor
that processes customer data has a current SOC 2 Type II report on file
or is on the quarterly-review queue to obtain one.

## Known gaps (as of 2026-05-12)

Documented here, tracked in `docs/soc2-gap-assessment.md`:

- No application-layer envelope encryption for TOTP secrets or PII
  columns. D1/Railway-disk encryption is the only at-rest control.
- No alerting rules on Sentry / Cloudflare metrics. (M2)
- No tested backup restoration drill yet. (H3 — runbook in
  `docs/backup-runbook.md`; first drill pending operator.)
- Account-level MFA on Cloudflare/Railway/Stripe dashboards — operator-
  level task, not code. (C4 supplement.)
- No secondary on-call. (CC9.)

## Review cadence

Quarterly. Last review row at the top.

| Date | Reviewer | Changes |
|------|----------|---------|
| 2026-05-12 | Max | Initial document, alongside SOC 2 C1/C2/C3/C4 commits |
