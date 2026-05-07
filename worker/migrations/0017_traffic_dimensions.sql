-- 0017_traffic_dimensions.sql — Phase 1 of Traffic Impact data-depth roadmap (May 6 2026)
--
-- Extends traffic_daily with engagement quality + acquisition mix dimensions.
-- New columns are nullable / default-zero so backfilled rows from migration
-- 0016 stay queryable. Geography lives in a sibling table (next migration)
-- because country/city is high-cardinality and would explode row count.

ALTER TABLE traffic_daily ADD COLUMN engagement_rate REAL;
ALTER TABLE traffic_daily ADD COLUMN avg_session_duration_sec INTEGER;
ALTER TABLE traffic_daily ADD COLUMN bounce_rate REAL;
ALTER TABLE traffic_daily ADD COLUMN new_users INTEGER NOT NULL DEFAULT 0;
ALTER TABLE traffic_daily ADD COLUMN returning_users INTEGER NOT NULL DEFAULT 0;
