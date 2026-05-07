-- 0018_traffic_geography.sql — Phase 1 PR 2 of Traffic Impact data-depth roadmap.
--
-- Country/city is high-cardinality (could be 100+ rows/day/tenant) so it
-- lives in a sibling table, NOT as columns on traffic_daily. Source data
-- comes from a SECOND GA4 runReport call with dimensions [date, country,
-- city, sessionSource, sessionMedium]. AI vs Human classification mirrors
-- the main classifier so the same source/medium → ai/human rules apply.

CREATE TABLE IF NOT EXISTS traffic_geo_daily (
  slug              TEXT NOT NULL,
  date              TEXT NOT NULL,
  country           TEXT NOT NULL,
  city              TEXT NOT NULL DEFAULT '',  -- '' for country-only rows
  ai_sessions       INTEGER NOT NULL DEFAULT 0,
  human_sessions    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, date, country, city)
);
CREATE INDEX IF NOT EXISTS idx_traffic_geo_slug_date ON traffic_geo_daily(slug, date);
