-- Rollback for 0007_onboarding_state.sql. Drops the three onboarding
-- columns from the businesses table.
--
-- Safe to run if the columns don't exist (SQLite will error on the
-- first DROP COLUMN — run statements individually if needed).
--
-- Run with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote \
--     --file=migrations/0007_onboarding_state_rollback.sql

ALTER TABLE businesses DROP COLUMN first_dashboard_at;
ALTER TABLE businesses DROP COLUMN onboarded_at;
ALTER TABLE businesses DROP COLUMN onboarding_state;
