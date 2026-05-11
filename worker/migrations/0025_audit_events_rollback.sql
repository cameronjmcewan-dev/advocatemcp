-- Rollback for migration 0025 — audit_events table
--
-- Apply with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0025_audit_events_rollback.sql

DROP INDEX IF EXISTS idx_audit_events_target;
DROP INDEX IF EXISTS idx_audit_events_type;
DROP INDEX IF EXISTS idx_audit_events_actor;
DROP INDEX IF EXISTS idx_audit_events_occurred;
DROP TABLE IF EXISTS audit_events;
