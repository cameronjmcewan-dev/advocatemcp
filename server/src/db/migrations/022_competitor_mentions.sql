-- 022_competitor_mentions.sql
--
-- Adds per-tenant competitor list + per-query mention-extraction so we
-- can answer "what competitors are AI users asking about in the same
-- breath as this tenant?" That question powers:
--
--   * Tenant-side: "Of the pricing queries in your category last week,
--     47% also mentioned <competitor>." (future Pro-tier insight)
--   * Admin-side / Tier 2 data product: cross-tenant competitor
--     co-mention aggregate — surfaced in /admin/queries.html.
--
-- Both columns are nullable + additive so the migration is safe on a
-- live prod DB. Empty competitor list → extractor skips silently.
-- Existing rows keep NULL competitors_mentioned until a backfill runs
-- or new queries overwrite their own row.

ALTER TABLE businesses ADD COLUMN competitors TEXT;
-- competitors: optional comma-separated list of competitor names, e.g.
-- "Scrunch AI, Profound, BrightEdge". Extractor does case-insensitive
-- word-boundary matches against query_text. Free-form so a tenant can
-- name a specific local rival ("Joe's Pizza Austin") without taxonomy
-- plumbing.

ALTER TABLE queries ADD COLUMN competitors_mentioned TEXT;
-- competitors_mentioned: JSON array of matched competitor names from
-- the tenant's competitors list, e.g. ["Scrunch AI", "Profound"].
-- Empty array = scanned but nothing matched. NULL = not yet scanned
-- (either pre-migration rows or extractor failed).

-- Index supports cross-tenant "top co-mentioned competitors in the
-- last N days" aggregate queries. JSON1 extensions aren't uniformly
-- available so we use plain column LIKE scans — index shape matches
-- the 30-day time window used by insights.ts.
CREATE INDEX IF NOT EXISTS idx_queries_competitors_ts
  ON queries(timestamp)
  WHERE competitors_mentioned IS NOT NULL AND competitors_mentioned != '[]';
