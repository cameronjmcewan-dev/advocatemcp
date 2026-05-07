-- 0021_revenue_attribution.sql — Phase 4 of Traffic Impact data-depth
-- roadmap. Extends revenue_events with first-touch attribution columns
-- so verified webhook deliveries can be split AI vs Human on the dashboard.
--
-- Attribution method (v1, time-window): for each new revenue event,
-- query click_events for the same business_slug within 24h before
-- occurred_at. If any AI-classified click exists (PerplexityBot,
-- ChatGPT, etc.), set referrer_classification='ai' + record source/
-- medium. Else 'unknown' (NEVER 'human' — we don't fabricate
-- attribution we can't prove).
--
-- All columns nullable so existing rows from migration 0009 stay valid.
-- Backfill is forward-only — older revenue_events don't get retro-
-- attribution because their click_events window is gone.

ALTER TABLE revenue_events ADD COLUMN referrer_classification TEXT;
ALTER TABLE revenue_events ADD COLUMN first_touch_source      TEXT;
ALTER TABLE revenue_events ADD COLUMN first_touch_medium      TEXT;
ALTER TABLE revenue_events ADD COLUMN first_touch_clicked_at  TEXT;

CREATE INDEX IF NOT EXISTS idx_revenue_events_classification
  ON revenue_events(business_slug, referrer_classification);
