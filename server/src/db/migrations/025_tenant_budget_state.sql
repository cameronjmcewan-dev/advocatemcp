-- Per-tenant daily AI-spend cap.
--
-- Background: server/src/middleware/budgetKillSwitch.ts already caps
-- TOTAL daily spend at $25/day (durable since migration 024). What
-- that doesn't catch: a single misbehaving tenant aggregating spend
-- across multiple endpoints (profile-score + verify-rating + future
-- additions) — even with each endpoint's per-route rate limit, the
-- per-tenant aggregate can creep up and crowd out the rest of the
-- fleet's headroom.
--
-- This table tracks per-(slug, day) reservations + actual spend so
-- the new tenantBudget middleware can refuse a request that would
-- push that one tenant's day total over the per-tenant cap (default
-- $5/day, override via PER_TENANT_DAILY_BUDGET_USD env var).
--
-- Same shape as budget_state but keyed by (slug, date_key). One row
-- per tenant per day. We don't DELETE — historical days stay around
-- as a billing-lookalike trail; year-scale prune is plenty.
CREATE TABLE IF NOT EXISTS tenant_budget_state (
  slug          TEXT NOT NULL,
  date_key      TEXT NOT NULL,        -- YYYY-MM-DD UTC
  spent_usd     REAL NOT NULL DEFAULT 0,
  reserved_usd  REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (slug, date_key)
);

-- Index for the admin "show me today's biggest spenders" view.
CREATE INDEX IF NOT EXISTS idx_tenant_budget_state_date
  ON tenant_budget_state (date_key, spent_usd DESC);
