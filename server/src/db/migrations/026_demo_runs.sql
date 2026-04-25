-- Homepage demo widget analytics.
--
-- Each row records one click on the homepage live-MCP-demo widget at
-- /demo/agent/run or /demo/agent/availability. Lets us measure widget
-- → /Pricing.html conversion and detect abuse patterns.
--
-- ip_hash is the first 16 hex chars of sha256(remote_ip), so the raw
-- visitor IP never lands in the DB. demo_type distinguishes the two
-- endpoints. outcome flags whether the call succeeded.
--
-- Demo logging is best-effort (try/catch in routes/demo.ts). If this
-- table is missing the widget still works — we just lose the analytics
-- row. So this migration is additive and never blocking.
CREATE TABLE IF NOT EXISTS demo_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  demo_type   TEXT NOT NULL,        -- 'agent_run' | 'availability'
  outcome     TEXT NOT NULL          -- 'ok' | 'error'
);

-- Conversion-rate-by-day query needs a ts index for fast range scans.
CREATE INDEX IF NOT EXISTS idx_demo_runs_ts
  ON demo_runs (ts DESC);

-- Per-IP throttling check (when we want to see if a single IP is
-- driving the volume) needs an ip_hash index.
CREATE INDEX IF NOT EXISTS idx_demo_runs_ip
  ON demo_runs (ip_hash, ts DESC);
