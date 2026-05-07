-- 0019_conversion_daily.sql — Phase 2 of Traffic Impact data-depth roadmap.
--
-- Stores per-day per-event conversion counts split by source class
-- (AI vs Human via classifyTrafficSource). Pro-only feature — the read
-- endpoint enforces the plan gate; this table can hold rows for any
-- tenant who happens to have key_events configured + connected their
-- GA4. Rows aren't surfaced to base-tier dashboards.
--
-- total_revenue is nullable because not every key_event has a monetary
-- value (form submissions, sign-ups). When present, it's the SUM of
-- the GA4 eventValue across rows for that (slug, date, source_class,
-- event_name) tuple. Currency is recorded as a single string per row;
-- multi-currency tenants will have rows with mixed currencies which
-- the read endpoint groups + presents in the dominant currency.

CREATE TABLE IF NOT EXISTS conversion_daily (
  slug            TEXT NOT NULL,
  date            TEXT NOT NULL,
  source_class    TEXT NOT NULL,            -- 'ai' | 'human'
  event_name      TEXT NOT NULL,
  event_count     INTEGER NOT NULL DEFAULT 0,
  total_revenue   REAL,                     -- nullable
  currency        TEXT,                     -- e.g. 'USD', 'EUR'
  PRIMARY KEY (slug, date, source_class, event_name)
);
CREATE INDEX IF NOT EXISTS idx_conversion_slug_date ON conversion_daily(slug, date);
