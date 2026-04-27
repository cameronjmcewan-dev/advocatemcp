-- Migration 029 — Revenue attribution.
--
-- Backs the "Revenue attribution — see dollars from AI" feature on the Pro
-- pricing tier. Two tracking modes coexist:
--
--   1. Verified — customer's booking system POSTs HMAC-signed events to
--      /api/revenue-event/<slug>. Each event is one row in revenue_events.
--      Dashboard shows actual dollar amounts with a green "Verified" pill.
--
--   2. Estimated — customer enters their average ticket once
--      (avg_booking_value_cents). Dashboard multiplies confirmed reservations
--      in the window by that AOV and shows the result with an amber
--      "Estimated" pill so customers can't confuse it with verified data
--      (founder requirement: liability-safe framing).
--
-- When neither AOV nor verified events exist, dollar values are NEVER
-- displayed — only booking counts. This is enforced in the
-- computeRevenueWindow() helper, not by NULL-handling in the schema.
--
-- All changes are additive — safe to replay on the populated prod DB.

-- ── businesses table — three new columns ──────────────────────────────────
-- avg_booking_value_cents stored as INTEGER cents (no float drift). NULL
-- until the customer configures it. revenue_currency defaults to USD;
-- almost every customer is US-based but the column lets a UK/CA tenant
-- pick GBP/CAD without a future migration.
ALTER TABLE businesses ADD COLUMN avg_booking_value_cents INTEGER;
ALTER TABLE businesses ADD COLUMN revenue_webhook_secret  TEXT;
ALTER TABLE businesses ADD COLUMN revenue_currency        TEXT NOT NULL DEFAULT 'USD';

-- ── revenue_events table ──────────────────────────────────────────────────
-- One row per verified-revenue webhook delivery. external_ref is the
-- customer's own booking ID (stripe charge id, square payment id, internal
-- POS order number, etc.) used for dedup so a customer's webhook retry
-- can't double-count revenue. UNIQUE(business_slug, external_ref) lets the
-- INSERT-OR-IGNORE pattern in the worker route handle replays cheaply.
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
