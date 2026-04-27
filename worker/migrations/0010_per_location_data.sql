-- D1 mirror of server migration 032 — per-location attribution columns.
--
-- Worker D1 has revenue_events (Apr 27 2026, migration 0009). Reservations
-- and click_events live primarily on Railway, but we add the columns on
-- D1 too so a future mirror job can replicate them in lockstep without
-- a follow-up migration. The columns stay NULL until the agent's
-- structured-output extraction starts populating them.
--
-- Additive only, safe to replay on populated prod D1.

-- revenue_events is the one table we know exists on D1 today (added in
-- migration 0009). Reservations + click_events MAY exist (depends on
-- whether the worker ever mirrored them); IF NOT EXISTS guards against
-- both states.
ALTER TABLE revenue_events ADD COLUMN location_id TEXT;

CREATE INDEX IF NOT EXISTS idx_revenue_events_loc
  ON revenue_events(business_slug, location_id, occurred_at);
