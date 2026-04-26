-- Beta cohort tracking on the businesses table.
--
-- Lets us flag tenants who signed up with a Stripe promotion code
-- attached to one of our designated beta coupons (BETA_COUPON_IDS env
-- var, comma-separated). Used to:
--   - render a "you're in beta — N days left" banner in the dashboard
--   - send beta-specific weekly digest copy (asking for feedback rather
--     than reporting metrics)
--   - admin endpoint /admin/beta-tenants for the founder to see who's
--     in their cohort, days remaining, conversion likelihood
--   - cron job that emails "trial ending" reminders 7 + 1 day out
--
-- All four columns are NULL for non-beta tenants. Existing tenants
-- pre-Apr-26-2026 have NULL for all four (they never went through a
-- coupon-gated checkout). Backfill is unnecessary.
--
-- beta_started_at:    ISO timestamp when checkout completed with a
--                     beta coupon applied. Set once, never updated.
--
-- beta_ends_at:       ISO timestamp computed at signup from the
--                     coupon's duration_in_months. After this point,
--                     the tenant is on full pricing — Stripe handles
--                     that automatically; this column is for OUR UI.
--
-- beta_coupon_id:     Stripe coupon id ("coup_xyz123") that was
--                     applied. Lets us audit + cohort by coupon.
--
-- beta_cohort:        Free-text label, defaults to "beta_YYYY_MM" at
--                     signup. Future cohorts can override via
--                     metadata on the coupon if we ever want named
--                     campaigns ("design-partners", "early-customers").

ALTER TABLE businesses ADD COLUMN beta_started_at TEXT;
ALTER TABLE businesses ADD COLUMN beta_ends_at    TEXT;
ALTER TABLE businesses ADD COLUMN beta_coupon_id  TEXT;
ALTER TABLE businesses ADD COLUMN beta_cohort     TEXT;

-- Index for the admin "list active beta tenants" query: only beta
-- rows, sorted by ends_at ascending so the soonest-to-expire are first.
-- Used by GET /admin/beta-tenants and the trial-ending email cron.
CREATE INDEX IF NOT EXISTS idx_businesses_beta_active
  ON businesses (beta_ends_at)
  WHERE beta_started_at IS NOT NULL;
