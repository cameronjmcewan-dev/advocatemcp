-- 0023_ltv_daily.sql — Phase 5 PR 3 of Traffic Impact data-depth roadmap.
--
-- Aggregate-only daily snapshot of CRM LTV per source class. Stores
-- ROLL-UP NUMBERS only — never individual contact rows. Privacy
-- posture: this table holds zero PII at any point. The cron computes
-- aggregates via aggregateLtv() (which runs in-memory on contacts
-- fetched live from the CRM) and writes ONLY the bucket totals here.
--
-- One row per (slug, date, provider, source_class). source_class is
-- 'ai' or 'unknown' — never 'human' (no fabricated attribution).

CREATE TABLE IF NOT EXISTS ltv_daily (
  slug                 TEXT NOT NULL,
  date                 TEXT NOT NULL,
  provider             TEXT NOT NULL,                    -- 'hubspot' | 'salesforce'
  source_class         TEXT NOT NULL,                    -- 'ai' | 'unknown'
  contact_count        INTEGER NOT NULL DEFAULT 0,
  customer_count       INTEGER NOT NULL DEFAULT 0,
  total_revenue_cents  INTEGER NOT NULL DEFAULT 0,
  avg_ltv_cents        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, date, provider, source_class)
);
CREATE INDEX IF NOT EXISTS idx_ltv_daily_slug_date ON ltv_daily(slug, date);
