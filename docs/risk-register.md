# Risk Register

**Owner:** Max.
**Last reviewed:** 2026-05-12.
**Review cadence:** Quarterly. Each review re-scores likelihood × impact,
adds new risks observed since the last cycle, retires mitigated ones.

> SOC 2 CC3 (risk assessment) requires a documented inventory of the risks
> the company has identified, with owner + mitigation + residual exposure.
> This register is the living version of that. It deliberately stays SHORT
> — top 10 — so it gets reviewed instead of ignored.

## Scoring rubric

- **Likelihood:** 1 (rare), 2 (unlikely), 3 (possible), 4 (likely), 5 (near-certain) — over a 12-month window.
- **Impact:** 1 (minor cosmetic), 2 (single-tenant outage / minor PR), 3 (major degradation / reputational), 4 (breach of <100 records), 5 (breach of >100 records / regulatory exposure).
- **Score = L × I.** Anything ≥ 12 is "act this quarter." 6–11 is "this year." ≤ 5 is "track."

## Top risks (2026-05-12)

| # | Risk | L | I | Score | Owner | Mitigation in place | Residual + next action |
|---|------|---|---|-------|-------|---------------------|------------------------|
| R1 | Cloudflare account takeover (single point of failure for Worker, D1, KV, Pages, R2, custom hostnames) | 2 | 5 | 10 | max | Strong unique password, account-level MFA pending operator | Enable account-level MFA today (10 min). Add a secondary recovery email separate from the primary. |
| R2 | Stripe webhook secret compromise → forged subscription events / billing manipulation | 2 | 4 | 8 | max | Dual-secret rotation pattern (`STRIPE_WEBHOOK_SECRET_PREVIOUS`), incident playbook for rotation, signature verification fail-closed | Rotation runbook in `docs/secrets-runbook.md`. Quarterly preventative rotation. |
| R3 | Single-engineer continuity (bus-factor 1) | 3 | 5 | 15 | max | Documented runbooks, source on GitHub, infra in Cloudflare/Railway accounts with documented credentials | **Top open item.** Identify a secondary contact for unreachable-Max scenarios. Document password-vault recovery for that contact. |
| R4 | Customer PII retention drift (window slips past policy) | 2 | 3 | 6 | max | redactStalePii() runs both per-call and on a 6-hour cron (post-H5) | Track redacted-row counts in dashboards; alert if 30 days pass with zero redactions on a busy tenant (suggests sweep broke). |
| R5 | Tenant API key leak (customer dashboard, screenshare, screenshot) | 3 | 3 | 9 | max | Hashed at rest (post-C1), rotation endpoint exists, business_status enforcement (post-C2) revokes on subscription cancel | Make key-rotation a customer-visible action in the dashboard (today it's API-only). |
| R6 | Admin account compromise (no MFA on admin login) | 2 | 5 | 10 | max | TOTP enrollment shipped (post-C4); admin enrollment NOT mandatory yet | Mandate TOTP enrollment for admin role: deny login if `users.role='admin' AND totp_enabled_at IS NULL` after a grace period. |
| R7 | Anthropic API outage / quota → agent queries fail | 4 | 2 | 8 | max | Circuit breaker on timeout (10s); Sentry alert; cron retries | Cache last-known-good response per slug for 30 min — graceful degradation. Tracked separately. |
| R8 | Railway volume failure → loss of SQLite (queries, reservations, audit data) | 1 | 5 | 5 | max | Railway provider snapshots; manual export procedure in `docs/backup-runbook.md` | Litestream to R2 (drops RPO from 24h to seconds). Quarterly restore drill. |
| R9 | Dependabot CVE shipping to prod undetected | 3 | 3 | 9 | max | Dependabot enabled weekly; npm audit advisory in CI | Triage existing 6 advisories on default branch; flip the npm audit gate from advisory to hard-fail. |
| R10 | Customer brand-damage event (a tenant agent publishes an inaccurate or harmful answer) | 3 | 3 | 9 | max | Tone + content guidelines on agent prompts; per-tenant rate limit; manual review of all live agents during ramp | Add per-tenant content moderation pass before publishing any agent response. |

## Retired (mitigated since last review)

| # | Risk | Retired | Why |
|---|------|---------|-----|
| _none yet — first review_ | | | |

## How to add a new risk

1. Notice a risk during code review, incident, customer report, or audit prep.
2. Score it likelihood × impact using the rubric above.
3. Add to the table with owner, current mitigation, residual + next action.
4. If it's ≥ 12, escalate immediately (next standup or DM, not "next quarter").

## Review log

| Date | Reviewer | Changes |
|------|----------|---------|
| 2026-05-12 | Max | Initial register, alongside the SOC 2 readiness work. |
