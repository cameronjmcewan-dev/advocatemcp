-- 0020_gsc.sql — Phase 3 of Traffic Impact data-depth roadmap.
--
-- Two tables for the Google Search Console integration:
--
-- gsc_connections — per-tenant OAuth state for the GSC API. Mirrors
-- ga4_connections's shape exactly so the Settings UI can render a
-- consistent "connection card" pattern. Refresh token AES-GCM encrypted
-- via the same key (GA4_TOKEN_ENCRYPTION_KEY — name kept for backward-
-- compat though the lib is now generic) so a D1 dump never reveals
-- plaintext tokens.
--
-- gsc_daily — per-day per-query search-impression data. ai_overview_shown
-- flagged 0/1 based on whether GSC reported the query as having shown an
-- AI Overview at search time (via searchAppearance: aiOverview, populated
-- in Phase 3 PR 4). Capped at top-100 queries per day per tenant in the
-- sync job to keep table size bounded.

CREATE TABLE IF NOT EXISTS gsc_connections (
  slug                TEXT PRIMARY KEY,
  refresh_token_enc   TEXT NOT NULL,
  site_url            TEXT,
  status              TEXT NOT NULL DEFAULT 'connected',
  last_sync_at        TEXT,
  last_sync_error     TEXT,
  connected_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (slug) REFERENCES businesses(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gsc_daily (
  slug                TEXT NOT NULL,
  date                TEXT NOT NULL,
  query               TEXT NOT NULL,
  impressions         INTEGER NOT NULL DEFAULT 0,
  clicks              INTEGER NOT NULL DEFAULT 0,
  ctr                 REAL,
  position            REAL,
  ai_overview_shown   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, date, query)
);
CREATE INDEX IF NOT EXISTS idx_gsc_daily_slug_date ON gsc_daily(slug, date);
