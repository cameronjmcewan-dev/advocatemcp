-- Session 9: reservations — 15-min HELD → CONFIRMED transactional holds.
-- HELD created by reserve_slot; CONFIRMED by /a2a/confirm posting the
-- signed confirmation_token. Expired holds swept synchronously on the
-- next reserve_slot call (no cron in v1).
CREATE TABLE IF NOT EXISTS reservations (
  id                    TEXT PRIMARY KEY,
  business_slug         TEXT NOT NULL,
  agent_id              TEXT,
  requested_at          INTEGER NOT NULL,
  window_start          INTEGER NOT NULL,
  window_end            INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('held','confirmed','rejected','expired')),
  confirmation_token    TEXT NOT NULL,
  customer_contact_json TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_reservations_slug_window
  ON reservations(business_slug, window_start);

CREATE INDEX IF NOT EXISTS idx_reservations_expiry
  ON reservations(status, expires_at);
