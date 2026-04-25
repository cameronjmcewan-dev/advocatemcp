-- Persist the daily AI budget kill-switch across Railway redeploys.
--
-- Background: server/src/middleware/budgetKillSwitch.ts caps total
-- Anthropic+Places spend at DAILY_BUDGET_USD per UTC day. v0 kept the
-- counter in memory, which meant a restart (Railway deploy, OOM, crash)
-- silently reset spent_usd to 0 and let an attacker who triggered
-- multiple deploys reset the budget multiple times. With this table the
-- counter is durable: every reserve/record/release flushes through to
-- SQLite, and the in-memory cache is rehydrated on first access after
-- restart.
--
-- One row per UTC day. We never DELETE — historical days stay around as
-- a forensic record of spend history (also useful for finance reports).
-- A bit of cron-side pruning at year scale is plenty.
CREATE TABLE IF NOT EXISTS budget_state (
  date_key      TEXT PRIMARY KEY,    -- YYYY-MM-DD UTC
  spent_usd     REAL NOT NULL DEFAULT 0,
  reserved_usd  REAL NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL        -- ISO timestamp of last mutation
);
