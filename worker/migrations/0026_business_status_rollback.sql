-- Rollback for migration 0026 — businesses lifecycle state
--
-- Apply with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0026_business_status_rollback.sql

DROP INDEX IF EXISTS idx_businesses_status;
ALTER TABLE businesses DROP COLUMN status_changed_at;
ALTER TABLE businesses DROP COLUMN business_status;
