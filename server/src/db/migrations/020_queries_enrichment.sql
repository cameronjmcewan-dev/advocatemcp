-- Migration 020 — Layer 1 instrumentation on the queries table.
--
-- Per ~/.claude/plans (advocate-data-layer-vision.md), Phase 1 turns the
-- query log into a first-class dataset rather than a side-effect telemetry
-- table. Every AI query should carry enough structured context to answer
-- future business questions without JOINs or guesswork.
--
-- All columns nullable so the migration is safe to replay and the existing
-- ~100 production rows don't need a backfill before deploy. Backfill runs
-- separately via server/src/jobs/backfillQueries.ts.
--
-- Columns added:
--   tokens_in / tokens_out / model / cost_cents — per-query Claude spend,
--     sourced from message.usage on every Claude call. Lets us answer
--     "what did this tenant cost us this month" and "did Sonnet vs Haiku
--     change answer quality on a specific intent."
--   outcome — unified outcome signal (none|click|reservation|handoff|error).
--     Consolidates the split between queries.referral_clicked (click only)
--     and agent_requests.outcome_signal (MCP-call chain). Lets a single
--     query row answer "did this become anything."
--   geo_country / geo_region / geo_city — from request.cf on the edge.
--     Worker forwards as X-Geo-* headers; handler stamps the row. Enables
--     Layer 4 geographic heat maps without per-lookup IP resolution.
--   industry_code — frozen taxonomy (see server/src/agent/taxonomy.ts)
--     derived from businesses.category. Denormalised at insert so
--     aggregate queries don't need a JOIN and so a future category
--     rename doesn't rewrite history.
--   intent_v2 — Haiku-classified intent, written asynchronously AFTER the
--     HTTP response is returned so response latency is unaffected. Held
--     alongside the existing keyword-classified `intent` column so we
--     can compare classifier quality before fully migrating.

ALTER TABLE queries ADD COLUMN tokens_in     INTEGER;
ALTER TABLE queries ADD COLUMN tokens_out    INTEGER;
ALTER TABLE queries ADD COLUMN cost_cents    INTEGER;
ALTER TABLE queries ADD COLUMN model         TEXT;
ALTER TABLE queries ADD COLUMN outcome       TEXT;
ALTER TABLE queries ADD COLUMN geo_country   TEXT;
ALTER TABLE queries ADD COLUMN geo_region    TEXT;
ALTER TABLE queries ADD COLUMN geo_city      TEXT;
ALTER TABLE queries ADD COLUMN industry_code TEXT;
ALTER TABLE queries ADD COLUMN intent_v2     TEXT;

-- Indexes for the Phase 2 internal dashboard read path. We'll filter by
-- industry + intent + time-window most often, and by geo region for the
-- Layer 4 aggregate views.
CREATE INDEX IF NOT EXISTS idx_queries_industry_ts ON queries (industry_code, timestamp);
CREATE INDEX IF NOT EXISTS idx_queries_intent_v2_ts ON queries (intent_v2, timestamp);
CREATE INDEX IF NOT EXISTS idx_queries_geo_region   ON queries (geo_country, geo_region);
