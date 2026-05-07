-- 0016_ga4_traffic.sql — Traffic Impact feature (May 6 2026)
--
-- ga4_connections: per-tenant GA4 OAuth state. refresh_token is AES-GCM
-- encrypted with the worker secret GA4_TOKEN_ENCRYPTION_KEY before being
-- written here, so a D1 dump never reveals plaintext tokens.
--
-- traffic_daily: daily-bucketed session counts pre-classified into AI vs
-- human (see worker/src/lib/aiTrafficClassifier.ts). Populated by the
-- nightly sync job (worker/src/cron/ga4Sync.ts). The Traffic Impact page
-- reads from this table for the headline graphs.

CREATE TABLE IF NOT EXISTS ga4_connections (
  slug                TEXT PRIMARY KEY,
  refresh_token_enc   TEXT NOT NULL,
  property_id         TEXT,
  property_label      TEXT,
  status              TEXT NOT NULL DEFAULT 'connected',
  last_sync_at        TEXT,
  last_sync_error     TEXT,
  connected_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (slug) REFERENCES businesses(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS traffic_daily (
  slug              TEXT NOT NULL,
  date              TEXT NOT NULL,
  ai_sessions       INTEGER NOT NULL DEFAULT 0,
  human_sessions    INTEGER NOT NULL DEFAULT 0,
  total_sessions    INTEGER NOT NULL DEFAULT 0,
  top_sources_json  TEXT,
  PRIMARY KEY (slug, date)
);

CREATE INDEX IF NOT EXISTS idx_traffic_daily_slug_date
  ON traffic_daily(slug, date);
