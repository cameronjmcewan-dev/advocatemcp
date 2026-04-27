-- Migration 032 — Per-location attribution columns + indices.
--
-- Adds `location_id` to the three event tables that should be filterable
-- per-location on the dashboard: reservations, click_events, revenue_events.
-- The agent (server/src/agent/query.ts) stamps location_id on the row
-- it creates when its answer references a specific location from the
-- Locations: prompt block.
--
-- Soft FK only (no FOREIGN KEY clause on these ALTERs because SQLite's
-- ALTER TABLE doesn't support adding a constraint, and a hard FK on
-- analytics rows means deleting a location cascades-deletes a year of
-- data — undesirable. Orphan rows are tolerated; they show up under
-- "All locations" but never under any specific location filter).
--
-- Backfill: existing rows get location_id = NULL → "All locations"
-- attribution. Forward-only — we don't try to retroactively guess
-- which historical reservation was for which location.
--
-- Additive only, safe to replay on populated prod DB.

ALTER TABLE reservations    ADD COLUMN location_id TEXT;
ALTER TABLE click_events    ADD COLUMN location_id TEXT;
ALTER TABLE revenue_events  ADD COLUMN location_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reservations_loc
  ON reservations(business_slug, location_id, requested_at);

CREATE INDEX IF NOT EXISTS idx_click_events_loc
  ON click_events(business_slug, location_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_revenue_events_loc
  ON revenue_events(business_slug, location_id, occurred_at);
