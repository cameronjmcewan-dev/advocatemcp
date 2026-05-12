-- Rollback for migration 0027 — TOTP enrollment columns
--
-- Apply with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0027_users_totp_rollback.sql

ALTER TABLE users DROP COLUMN totp_enabled_at;
ALTER TABLE users DROP COLUMN totp_secret;
