-- Migration 038 — businesses lifecycle state (mirrors worker D1 migration 0026)
--
-- SOC 2 CC6.2/CC6.3: enforces the same business_status column on the
-- Railway/SQLite side that worker/migrations/0026 added on the Cloudflare D1
-- side. The auth middleware in server/src/middleware/auth.ts reads this
-- column on every authenticated request and 401s when the status is
-- 'cancelled' or 'suspended'.
--
-- Source of truth for status transitions is the Cloudflare Worker (where the
-- Stripe webhook fires). The Worker pushes status updates here via the new
-- POST /agents/:slug/status admin endpoint, gated by X-API-Key (SERVER_API_KEY).
-- A divergence between the two DBs is recoverable: re-run the Worker's
-- railway reconciler cron, or PATCH manually with curl.
--
-- Status vocabulary (must stay in sync with worker/migrations/0026):
--   active     — paid + good standing  (default for new rows)
--   cancelling — cancel_at_period_end=true; still within paid period
--   past_due   — invoice retry in progress
--   cancelled  — subscription deleted; access BLOCKED at auth middleware
--   suspended  — admin manually disabled; access BLOCKED at auth middleware
--
-- ALTER TABLE ADD COLUMN with DEFAULT applies the default to the column
-- metadata; existing rows are populated lazily from the default on read.
-- No backfill UPDATE needed.

ALTER TABLE businesses ADD COLUMN business_status    TEXT NOT NULL DEFAULT 'active';
ALTER TABLE businesses ADD COLUMN status_changed_at  TEXT;

CREATE INDEX IF NOT EXISTS idx_businesses_status
  ON businesses(business_status);
