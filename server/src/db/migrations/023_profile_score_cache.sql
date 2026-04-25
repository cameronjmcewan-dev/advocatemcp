-- Migration 023: cache last format-judge score per business + bounded history.
--
-- The customer-facing AI citation score (POST /agents/:slug/profile-score)
-- runs a 4-trial format-judge harness against the calling tenant's profile.
-- Each call costs ~$0.04 in Anthropic API spend. Without persistence we'd
-- need to re-run on every page load — paying that cost every time the
-- customer navigates to Overview or BusinessProfile.
--
-- Strategy: hash the renderable profile fields (description + ratings_json
-- + customer_quotes_json + ...) and cache the score keyed by hash. If the
-- next request's profile hash matches the stored hash, return the cached
-- score (no API call, instant). Profile mutation invalidates the cache
-- naturally — next request sees a hash mismatch and runs fresh.
--
-- last_score_json columns store the most recent score blob. score_history_json
-- is a bounded JSON array (last N runs) for the trend sparkline.
--
-- Both columns are nullable + ignored if missing — the score endpoint falls
-- back to "no cached score, run fresh" behavior so existing tenants without
-- a row get the same UX.

ALTER TABLE businesses ADD COLUMN last_score_json TEXT;
ALTER TABLE businesses ADD COLUMN score_history_json TEXT;
