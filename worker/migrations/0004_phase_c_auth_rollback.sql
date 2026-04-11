-- Phase C rollback: remove tenant_id column and index from users.
--
-- D1's SQLite version supports DROP COLUMN directly (SQLite 3.35+).
--
-- Run with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0004_phase_c_auth_rollback.sql

DROP INDEX IF EXISTS idx_users_tenant;

ALTER TABLE users DROP COLUMN tenant_id;
