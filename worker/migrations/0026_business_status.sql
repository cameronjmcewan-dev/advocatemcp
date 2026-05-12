-- Migration 0026 — businesses lifecycle state
--
-- SOC 2 CC6.2/CC6.3: when a tenant cancels (Stripe subscription deleted) or
-- their payment lapses, we need a way to record the lifecycle state separate
-- from the existing onboarding columns (activation_status / onboarding_state
-- both describe pre-activation flow, not post-activation suspension).
--
-- Two new columns:
--   business_status  — coarse lifecycle: 'active' | 'cancelling' | 'cancelled'
--                      | 'past_due' | 'suspended'. Default 'active' so existing
--                      rows light up as active without a backfill UPDATE.
--   status_changed_at — ISO timestamp of the most recent status transition.
--                       Audit-log rows carry the same transition; this column
--                       is the fast-read index for admin dashboards.
--
-- This migration is intentionally additive. Enforcement (auth middleware
-- checking business_status before honouring an API key) lives in a separate
-- change and ALSO requires the Railway server-side auth path to be updated.
-- Until that lands, this column is observational only — the Stripe webhook
-- records cancellation but does NOT yet block traffic.
--
-- Apply with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0026_business_status.sql

ALTER TABLE businesses ADD COLUMN business_status    TEXT NOT NULL DEFAULT 'active';
ALTER TABLE businesses ADD COLUMN status_changed_at  TEXT;

CREATE INDEX IF NOT EXISTS idx_businesses_status
  ON businesses(business_status);
