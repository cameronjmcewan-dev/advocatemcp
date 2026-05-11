# SOC 2 Common Criteria — Gap Assessment

**Date:** 2026-05-11
**Scope:** AdvocateMCP (`worker/`, `server/`, `site/`)
**TSC:** Security (Common Criteria) only — CC1 through CC9
**Method:** Static review of HEAD on `claude/soc2-compliance-audit-yYL77`. File:line
citations are from the audit run and should be spot-checked before remediation —
they were produced by automated exploration agents and may drift.

> This is a readiness/gap assessment, **not** a SOC 2 attestation. Attestation
> requires a licensed CPA firm running Type I (point-in-time) or Type II
> (3–12 month observation). This document is the artifact you give that firm to
> shorten the engagement.

---

## Executive verdict

**Code posture:** Stronger than typical for a solo-founder pre-audit. Retention
enforcement, HMAC domain separation, parameterized SQL, rate limiting, vendor
transparency, and secrets externalization are all working.

**Audit-readiness:** Not ready. Four findings would be flagged as material on
day one of a Type I. Six more would be flagged as control deficiencies. Policy
and governance work (CC1–CC3) has not started.

**Time to readiness estimate (solo):** 3–4 weeks of focused work on the criticals,
plus 1–2 weeks drafting policies, before engaging an auditor.

---

## Critical — must fix before any auditor engagement

### C1 — API keys stored plaintext in D1 (CC6.1)
Tenant API keys are stored unencrypted in `businesses.api_key` and validated by
direct SQL equality. The lookup is not constant-time — timing depends on the DB
index scan, which is a non-zero side channel.

- `worker/migrations/0001_init.sql:21` — schema declares plaintext column
- `server/src/middleware/auth.ts:34,75` — `WHERE api_key=?` lookup, no hashing

**Fix:** Hash on storage with PBKDF2-SHA256 (cheap on Workers) or argon2 on the
Railway side. Store `api_key_hash` + `api_key_prefix` (first 8 chars, for
display/log/grep). Validate by prefix lookup + `timingSafeEqual` on the hash.
Rotation: on next key issuance, hash the new key; deprecate the column when no
plaintext rows remain.

### C2 — Cancelled subscriptions retain API access (CC6.2, CC6.3)
The Stripe webhook handler only processes `checkout.session.completed`.
`customer.subscription.deleted`, `customer.subscription.updated`, and
`invoice.payment_failed` all return 200 with no action. A cancelled tenant keeps
their API key indefinitely.

- `worker/src/routes/stripe.ts:1189-1192` — sole event handler

**Fix:** Add handlers for `customer.subscription.deleted` (revoke key, flag
business as `inactive`), `customer.subscription.updated` (handle downgrade), and
`invoice.payment_failed` (grace-period flag after Nth failure). Backfill: SQL
scan to find businesses whose Stripe sub status doesn't match the local flag.

### C3 — No security audit log (CC7.2)
There is no `audit_events` table. Operationally significant actions (API key
issuance, admin login, tenant deletion, secret rotation, impersonation, password
reset) leave no tamper-evident record. An auditor asking "show me every API key
ever issued and by whom" cannot be answered.

- No migration in `worker/migrations/` or `server/src/db/migrations/` creates
  such a table. `audit_followups` and `public_audits` are business features, not
  security audit.

**Fix:** Create `audit_events` table with `id`, `actor_type` (system|user|tenant),
`actor_id`, `event_type`, `target_type`, `target_id`, `metadata_json`,
`ip_hash`, `created_at`. Wire from: auth login/logout, key issuance/rotation,
admin impersonation start/stop, tenant delete, Stripe webhook processed events,
secret rotation (manual entry via CLI). Retention: indefinite for security
events; index on `(actor_id, created_at)` and `(event_type, created_at)`.

### C4 — No MFA on any privileged surface (CC6.1, CC6.6)
Admin dashboard, Cloudflare account, Railway, Stripe — all single-factor. No
TOTP, WebAuthn, or step-up auth references in the codebase. The
`X-Admin-Secret` header in Stripe routes is also single-factor (shared secret).

- No grep matches for `totp`, `mfa`, `webauthn`, `passkey` in `worker/src/` or
  `server/src/`.

**Fix:**
1. Enable MFA on Cloudflare, Railway, Stripe dashboards today (account-level,
   not code) — 10 minutes total.
2. Add TOTP to admin dashboard login: store `totp_secret` column on the admin
   user, require code on each login. WebAuthn is better but TOTP is the
   cheapest path to passing the audit line.

---

## High — should fix before Type II observation window starts

### H1 — Tenant impersonation enforced client-side only (CC6.6)
Admin dashboard injects `?as=<slug>` from JS to scope subsequent API calls, but
server routes do not cross-check the Bearer token's authorized tenants against
the `:slug` path parameter on per-tenant endpoints.

- `site/js/dashboard-auth.js:106-114` — client-side scoping
- Per-tenant API routes accept `:slug` from path without intersecting with the
  authenticated user's `user_business_access` row(s)

**Fix:** In `requireAuth`, after token verification, resolve allowed tenant
slugs from `user_business_access`. On every `/api/tenants/:slug/*` route, assert
`:slug ∈ allowedSlugs` or return 403. For staff/superadmin impersonation, gate
behind a dedicated `act_as` token with its own audit event.

### H2 — Incident response process undocumented (CC7.3, CC7.4)
The April 13 wildcard route incident was fixed in code, but no postmortem,
runbook, or escalation path exists. CLAUDE.md merely notes "resolved."

- No file in `docs/` matches `*incident*`, `*postmortem*`, `*ir*`, `*runbook*`
  for IR (operational runbooks exist for onboarding and secrets).

**Fix:** Add `docs/incident-response.md` with: severity definitions (Sev0–Sev3),
on-call (you, plus a secondary), escalation/comms templates, postmortem
template. Backfill a one-page postmortem for the April 13 incident from git
history and Sentry traces.

### H3 — Backups not documented or tested (CC7.5, CC9.2)
D1 has Cloudflare-managed backups (relies on Cloudflare's SOC 2 — fine). The
Railway SQLite at `/app/data/dev.db` has no documented backup policy, no tested
restore, no RTO/RPO target.

- `server/src/db.ts:13-20` — DB path
- No backup script in `scripts/`, no `docs/backup-runbook.md`

**Fix:** Configure Railway volume snapshots (or scheduled `litestream` to R2),
document RTO (e.g., 4h) and RPO (e.g., 1h), run one restore drill, write a
two-page `docs/backup-runbook.md` covering both D1 and SQLite.

### H4 — No staging environment (CC8.1)
Worker, Pages, and server deploy `main` directly to production. Boot-smoke
catches startup failures; nothing catches routing or rendering regressions
before users hit them.

- `.github/workflows/deploy-worker.yml:61` — gated only on `main`

**Fix:** Add a staging Worker (`staging-customers.advocatemcp.com`) bound to a
separate D1 with seeded test data. Promote to prod by tag, not by push to main.
For Pages, the existing PR preview deploys are sufficient — document that they
are part of the change-management control.

### H5 — Stale PII redaction depends on traffic (CC7.2, CC9.2)
`redactStalePii()` only fires when `reserve_slot` is invoked. If no reservation
traffic arrives for a week, PII past its retention window lingers.

- `server/src/jobs/expirySweeper.ts:51-70` — implementation is correct
- `server/src/mcp/tools/reserveSlot.ts` — the only caller

**Fix:** Add a daily Cloudflare cron (`worker/src/cron/`) that POSTs to a new
`server/api/jobs/redact-pii` endpoint (admin-secret gated), or invert: move
the sweeper to a `node-cron` job on the Railway server side that runs every 6
hours. Keep the per-call invocation as a belt-and-suspenders.

### H6 — Session revocation absent (CC6.1)
Password change does not invalidate existing refresh tokens. No "log out
everywhere" action. Concurrent refresh-token use is not monitored.

- `worker/src/routes/authApi.ts:39-41` — token rotation works on refresh, but no
  cascading invalidation on password change

**Fix:** On password change, `DELETE FROM refresh_tokens WHERE user_id = ?`.
Add a `revoked_at` column for selective revocation. Track `last_used_at` per
refresh token and flag when the same token is used from >1 IP in <5 minutes.

---

## Medium — should fix during audit preparation

### M1 — `npm audit` not gated in CI (CC7.1)
Dependabot raises PRs, but CI does not fail on a known critical CVE in a PR's
dependency tree.

**Fix:** Add `npm audit --audit-level=high` to `.github/workflows/server-ci.yml`
and `deploy-worker.yml`. Allow override via labelled PR for known
false-positives, with the label change itself logged as an audit event.

### M2 — No alerting on Sentry / Cloudflare events (CC7.1, CC7.2)
Sentry receives errors but no alert rules are documented. No on-call rotation.
No escalation path written down.

**Fix:** Configure Sentry alert rules: any new `level=error` issue, error rate
>5/min on `/api/*`, any `customer.subscription.*` webhook 4xx/5xx. Pipe to a
phone-reaching channel (SMS via Twilio, since you already have it; or
PagerDuty/Better Stack — free tier ok).

### M3 — Pre-commit hooks absent (CC8.1)
No husky/lint-staged/pre-commit. Secrets and broken tests can be committed
locally and only caught in CI minutes later.

**Fix:** `husky` + `lint-staged` running `tsc --noEmit` and a `gitleaks`/
`trufflehog` scan on staged files. Roughly 30 minutes to set up across the two
workspaces.

### M4 — Key rotation runbook missing for `TOKEN_SIGNING_KEY` (CC9.2)
Secrets runbook covers Stripe and admin secrets. The HMAC `TOKEN_SIGNING_KEY` —
which signs attribution + a2a continuation tokens — is not in the runbook.

**Fix:** Add a section to `docs/secrets-runbook.md` covering the
`TOKEN_SIGNING_KEY` rotation ceremony, accepting that in-flight tokens fail
(short TTL minimises blast). Quarterly rotation cadence.

### M5 — Encryption-at-rest is implicit, not documented (CC9.2)
D1 is encrypted at rest by Cloudflare (their SOC 2 covers it). Railway SQLite
encryption status is unverified. API keys (post-fix C1) and PII columns are
plaintext at the application layer — defensible, but undocumented.

**Fix:** Add `docs/security-controls.md` with: data classification table (PII /
secrets / business data), at-rest controls per store (cite Cloudflare D1 SOC 2,
Railway disk encryption status — verify with Railway support), justification
for plaintext PII storage (rotatable, short retention, private network).

### M6 — Vendor management process undocumented (CC9.2)
Privacy policy lists sub-processors (good), but there is no process for
collecting their SOC 2 reports, reviewing them, or tracking renewal.

**Fix:** Add `docs/vendor-management.md` with a table: vendor, data shared,
SOC 2 report on file (link/date), next review date. Annual review cadence.
Fetch the latest SOC 2 reports from Cloudflare, Anthropic, Stripe, Railway,
Twilio, Resend — they all publish them under NDA from their trust portals.

---

## Low — closing-the-loop items

- **L1** — No CHANGELOG.md. `docs/followups.md` is a working journal, not a
  customer-facing change log. Add tag-driven release notes.
- **L2** — No formal risk register (CC3). Add `docs/risk-register.md` with the
  top 10 risks ranked by likelihood × impact, reviewed quarterly.
- **L3** — No employee security training records (CC1.4). One-person company
  still needs evidence: a dated note that you completed e.g. OWASP Top 10
  refresh works.
- **L4** — No formal access review (CC6.3). Quarterly: list every active
  user_business_access row, confirm each is still authorised.

---

## What this report does **not** cover

- **CC1 Control Environment** (governance, org chart, code of conduct)
- **CC2 Communication and Information** (board, internal comms)
- **CC3 Risk Assessment** (formal risk register process)
- **CC4 Monitoring Activities** (internal audit program)
- **CC5 Control Activities** (policy-doc layer)

These are policy/governance documents, not code. A solo founder targeting SOC 2
typically uses Vanta/Drata/Secureframe/Oneleet to template them. Plan on 1–2
weeks of writing or ~$10k–25k/year for a compliance platform.

Other TSCs not in scope of this run: Availability, Confidentiality, Processing
Integrity, Privacy. Confidentiality controls overlap heavily with CC6/CC9
findings above. The other three should be added to scope only if customers ask.

---

## Suggested remediation order

1. **Week 1 (criticals + quick high wins):** C2 (subscription handlers — fastest
   to ship), C3 (audit log schema + first three event types), C4 (enable MFA on
   Cloudflare/Railway/Stripe accounts immediately; admin TOTP can follow), H2
   (one-page IR doc, backfilled postmortem).
2. **Week 2 (criticals continued):** C1 (API key hashing + rotation backfill —
   needs careful migration). H1 (server-side tenant isolation check). H6
   (session revocation on password change).
3. **Week 3 (highs):** H3 (backup runbook + drill), H5 (cron-based PII sweep),
   H4 (staging environment).
4. **Week 4 (mediums + policy):** M1–M6 plus initial drafts of policy docs.
   Engage auditor for Type I scoping call.

Each critical and high item is <1 day of focused engineering. The
documentation/policy work is the slow bit.
