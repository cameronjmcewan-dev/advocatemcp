-- 0024_authority.sql — Phase 6 PR 1 of Traffic Impact data-depth roadmap.
--
-- Two tables for the Off-site Authority Kit:
--
-- authority_config — per-tenant configuration. brand_keyword is the
-- customer's free-text brand handle (e.g. "advocatemcp" or "Acme Co").
-- google_place_id added in PR 2. trustpilot_business_unit_id deferred
-- to a future PR (out of scope for v1).
--
-- off_site_authority_daily — aggregate daily roll-up per platform.
-- Stores ROLL-UP NUMBERS only — no individual mention text after
-- sentiment classification (top_mentions_json keeps top 3 mentions
-- for tooltip context only). Privacy posture: public data sources
-- only; no PII. Customer's authority signals.

CREATE TABLE IF NOT EXISTS authority_config (
  slug                          TEXT PRIMARY KEY,
  brand_keyword                 TEXT,                  -- e.g. "advocatemcp"
  reddit_enabled                INTEGER NOT NULL DEFAULT 1,
  google_place_id               TEXT,                  -- added live in PR 2
  configured_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at                TEXT,
  last_sync_error               TEXT,
  FOREIGN KEY (slug) REFERENCES businesses(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS off_site_authority_daily (
  slug              TEXT NOT NULL,
  date              TEXT NOT NULL,
  platform          TEXT NOT NULL,                     -- 'reddit' | 'google_reviews'
  mention_count     INTEGER NOT NULL DEFAULT 0,
  positive_count    INTEGER NOT NULL DEFAULT 0,
  neutral_count     INTEGER NOT NULL DEFAULT 0,
  negative_count    INTEGER NOT NULL DEFAULT 0,
  avg_sentiment     REAL,                              -- -1..1; NULL if mention_count = 0
  rating            REAL,                              -- platform-native rating where applicable (Google reviews)
  rating_count      INTEGER,                           -- platform-native rating count
  top_mentions_json TEXT,                              -- top 3 mentions for tooltip; truncated to 200 chars per mention
  PRIMARY KEY (slug, date, platform)
);
CREATE INDEX IF NOT EXISTS idx_off_site_slug_date ON off_site_authority_daily(slug, date);
