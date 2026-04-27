-- Migration 030 — Multi-location support.
--
-- Backs the "Up to 3 locations" (Pro) and "Unlimited locations"
-- (Enterprise) features on the Pricing page. The shape per the design:
-- one tenant, one slug, one Stripe sub. Each location is a row here.
-- The AI agent reads all locations from this table and disambiguates
-- queries by city/zip/keywords using the model's natural reasoning.
--
-- Backfill on apply: every existing tenant gets exactly one row in
-- locations, marked is_primary=1, with name/city/state/phone derived
-- from the businesses row's existing single-location fields. This keeps
-- downstream code that reads the legacy businesses.location free-text
-- value working until it migrates to query locations directly.
--
-- Plan-tier caps are enforced in application code (server/src/repos/
-- locations.ts addLocation()), not via SQL constraints, because the
-- caps are dynamic (read businesses.plan + count locations) and
-- changing the plan tier should not trigger an SQL trigger.

CREATE TABLE IF NOT EXISTS locations (
  id              TEXT PRIMARY KEY,
  business_slug   TEXT NOT NULL,
  name            TEXT NOT NULL,
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  postal_code     TEXT,
  country         TEXT NOT NULL DEFAULT 'US',
  phone           TEXT,
  hours_json      TEXT,
  is_primary      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_slug) REFERENCES businesses(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_locations_slug
  ON locations(business_slug);

-- Partial unique index — exactly one row per business may have
-- is_primary=1. SQLite supports partial unique indexes so we can enforce
-- "at most one primary" without polluting non-primary rows with the
-- constraint. Application code that promotes a non-primary to primary
-- must demote the existing primary first inside a transaction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_one_primary
  ON locations(business_slug)
  WHERE is_primary = 1;

-- Backfill: one location per existing tenant from their businesses row.
-- Uses INSERT-OR-IGNORE keyed on PRIMARY KEY id (which we generate
-- deterministically as 'loc_primary_<slug>') so a re-run of the migration
-- doesn't double-insert. The location parsing is best-effort: we split
-- the existing free-text "Austin, TX" into city + state when the comma
-- is present, otherwise the whole string lands in city and state stays
-- 'Unknown'. Customers can edit any of this from the Settings UI later.
INSERT OR IGNORE INTO locations
  (id, business_slug, name, city, state, phone, is_primary, created_at)
SELECT
  'loc_primary_' || slug,
  slug,
  name,
  -- City: text before the first comma, trimmed. Falls back to the whole
  -- location string when there's no comma (or the column is NULL → 'Unknown').
  CASE
    WHEN location IS NULL OR location = '' THEN 'Unknown'
    WHEN instr(location, ',') > 0 THEN trim(substr(location, 1, instr(location, ',') - 1))
    ELSE trim(location)
  END,
  -- State: text after the first comma, trimmed. 'Unknown' when absent so
  -- the NOT NULL constraint passes.
  CASE
    WHEN location IS NULL OR instr(location, ',') = 0 THEN 'Unknown'
    ELSE trim(substr(location, instr(location, ',') + 1))
  END,
  phone,
  1,
  CURRENT_TIMESTAMP
FROM businesses
WHERE slug NOT IN (SELECT business_slug FROM locations WHERE is_primary = 1);
