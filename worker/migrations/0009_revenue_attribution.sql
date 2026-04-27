-- D1 mirror of server migration 029 — revenue attribution.
--
-- The worker is the receiver for HMAC-signed customer webhook deliveries
-- (POST /api/revenue-event/<slug>). It writes verified events into D1 so
-- the dashboard's revenue card and the monthly performance review email
-- can read them without a Railway round-trip.
--
-- Server SQLite (Railway) holds the same shape via migration 029. Both
-- DBs stay in lockstep so a worker outage doesn't lose events: the
-- worker writes to D1, then a follow-up job mirrors to Railway. (Mirror
-- job is out of scope for this migration; columns ready when needed.)
--
-- Additive only — safe to replay on the populated prod D1.

ALTER TABLE businesses ADD COLUMN avg_booking_value_cents INTEGER;
ALTER TABLE businesses ADD COLUMN revenue_webhook_secret  TEXT;
ALTER TABLE businesses ADD COLUMN revenue_currency        TEXT NOT NULL DEFAULT 'USD';

CREATE TABLE IF NOT EXISTS revenue_events (
  id              TEXT PRIMARY KEY,
  business_slug   TEXT NOT NULL,
  reservation_id  TEXT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source          TEXT NOT NULL CHECK (source IN ('webhook','manual')),
  external_ref    TEXT,
  UNIQUE(business_slug, external_ref)
);

CREATE INDEX IF NOT EXISTS idx_revenue_events_slug_occurred
  ON revenue_events(business_slug, occurred_at);

CREATE INDEX IF NOT EXISTS idx_revenue_events_reservation
  ON revenue_events(reservation_id)
  WHERE reservation_id IS NOT NULL;
