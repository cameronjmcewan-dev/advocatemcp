-- Phase B of the dashboard redesign (Apr 29 2026):
--
-- Per-user named dashboards with JSON layout + filter state. Each user
-- can create multiple dashboards per business; one is marked is_default
-- and is the one /dashboard lands on if no :dashboardId is given.
--
-- Both `user_id` and `business_id` are TEXT (the existing D1 schema —
-- users.id and businesses.id are both TEXT PRIMARY KEY).
--
-- layout_json shape (validated server-side, not by SQL):
--   [{ "card_id": "visibilityScore", "size": "sm" }, ...]
-- filters_json shape:
--   { "date_range": "30d" | { start, end } | null,
--     "intent_filter": [...] | null,
--     "bot_filter":    [...] | null }
--
-- The UNIQUE(user_id, business_id, name) keeps a tenant from polluting
-- their dashboard list with duplicates. The partial index
-- idx_dashboards_default enforces "exactly one default per
-- (user, business)" — a second is_default=1 row violates the index.

CREATE TABLE IF NOT EXISTS dashboards (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  layout_json     TEXT NOT NULL,
  filters_json    TEXT NOT NULL DEFAULT '{}',
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_id, business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_dashboards_user_biz
  ON dashboards(user_id, business_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboards_default
  ON dashboards(user_id, business_id) WHERE is_default = 1;
