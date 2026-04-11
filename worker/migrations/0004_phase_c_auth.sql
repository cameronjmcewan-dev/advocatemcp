-- Phase C: cross-origin auth foundation
--
-- Adds a tenant_id column to the users table expressing the direct
-- customer→tenant relationship for new Phase C customer users. Existing
-- admin users keep tenant_id NULL and continue to use the existing
-- user_business_access join table pattern. Phase C customer users set
-- both tenant_id AND insert into user_business_access (hybrid pattern)
-- so read-path code like getUserBusinesses continues to work unchanged.
--
-- Additive only. Nullable column with no default constraint — no row
-- validation failures on existing rows. No data loss possible.
--
-- Rollback: run migrations/0004_phase_c_auth_rollback.sql to DROP the
-- column and index.
--
-- Run with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0004_phase_c_auth.sql

ALTER TABLE users ADD COLUMN tenant_id TEXT REFERENCES businesses(id);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
