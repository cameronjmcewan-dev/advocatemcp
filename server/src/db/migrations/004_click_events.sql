CREATE TABLE IF NOT EXISTS click_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  business_slug TEXT NOT NULL,
  ref           TEXT,
  user_agent    TEXT,
  ip_hash       TEXT,
  timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
  destination   TEXT,
  query_id      INTEGER,
  legacy        INTEGER NOT NULL DEFAULT 0
);
