-- Phase F Part 1 rollback: remove the activation token columns and
-- index from the businesses table. Mirrors 0004_phase_c_auth_rollback.
--
-- D1's SQLite version supports DROP COLUMN directly (SQLite 3.35+).
--
-- Run with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote \
--     --file=migrations/0005_phase_f_activation_token_rollback.sql

DROP INDEX IF EXISTS idx_businesses_activation_status;

ALTER TABLE businesses DROP COLUMN activation_issued_at;
ALTER TABLE businesses DROP COLUMN activation_status;
ALTER TABLE businesses DROP COLUMN activation_token;
