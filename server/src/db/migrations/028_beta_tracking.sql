-- Mirror of the worker D1 beta tracking columns to the Railway server's
-- SQLite businesses table. The worker is the source of truth (Stripe
-- webhook fires there), but the weekly digest job (server/src/jobs/
-- weeklyDigest.ts) and the trial-ending email cron (server/src/jobs/
-- betaEndingEmail.ts, added in this round) need to read beta status to
-- pick the right email copy. So we mirror the columns at the server's
-- /register endpoint when a new tenant signs up.
--
-- See worker/migrations/0008_beta_tracking.sql for the column rationale.

ALTER TABLE businesses ADD COLUMN beta_started_at TEXT;
ALTER TABLE businesses ADD COLUMN beta_ends_at    TEXT;
ALTER TABLE businesses ADD COLUMN beta_coupon_id  TEXT;
ALTER TABLE businesses ADD COLUMN beta_cohort     TEXT;

-- Index identical to the worker D1 side: filter to rows that are
-- actively in beta, sorted by ends_at so the trial-ending cron only
-- has to scan a small slice.
CREATE INDEX IF NOT EXISTS idx_businesses_beta_active
  ON businesses (beta_ends_at)
  WHERE beta_started_at IS NOT NULL;
