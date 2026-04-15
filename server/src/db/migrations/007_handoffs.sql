-- Session 9: handoffs — discriminated union on `mode`.
-- mode='human' → delivered_via + ticket_id populated, continuation_url NULL.
-- mode='agent' → continuation_url + handshake_token populated, delivered_via NULL.
-- reservation_id nullable: some handoffs happen without a prior reserve_slot.
CREATE TABLE IF NOT EXISTS handoffs (
  id                TEXT PRIMARY KEY,
  business_slug     TEXT NOT NULL,
  reservation_id    TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('human','agent')),
  delivered_via     TEXT CHECK (delivered_via IN ('sms','email') OR delivered_via IS NULL),
  continuation_url  TEXT,
  handshake_token   TEXT,
  ticket_id         TEXT,
  agent_id          TEXT,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_handoffs_slug ON handoffs(business_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_reservation ON handoffs(reservation_id);
