-- Phase 4 (grey-hat AI optimization, Apr 28 2026):
--   Auto-generated head-to-head comparison pages for Pro+ tenants.
--
-- Two tables:
--
-- 1. `competitors` — per-tenant competitor records with VERIFIED facts.
--    Distinct from the comma-separated names in `businesses.competitors`
--    (which is just a mention-extraction allowlist). This table holds the
--    structured data the comparison-page validator needs: each fact must
--    appear in `verified_facts_json` (typed JSON) AND have a public source
--    URL recorded in the `source_urls` array. Validator rejects rows where
--    a claimed fact isn't traceable to a row in this table.
--
--    No fabrication: the builder cron NEVER auto-fills verified_facts_json
--    from the open web. It's populated either:
--      a) Manually by an operator via /admin/competitors/:id/facts
--      b) By a future scraper PR that fetches structured data only from
--         declared schemas (LocalBusiness JSON-LD, Google Business
--         Profile API, etc.) — never narrative scrape.
--    Until verified_facts_json is non-null + non-empty, the strict
--    comparison validator rejects every row → no pages generate. This
--    is the intended posture.
--
-- 2. `comparison_pages` — output of the comparison_pages_builder cron.
--    Mirrors `synthetic_pages` shape (UNIQUE(host, path), status
--    lifecycle, generator_version) so the public route + worker matcher
--    can reuse the same patterns.
--
-- Both tables ship with default-deny behavior. Feature flag
-- `FEATURE_COMPARISON_PAGES` gates the builder cron + the public route.

CREATE TABLE IF NOT EXISTS competitors (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id          INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Display name + canonical slug for URL building. The slug must be
  -- deterministic: regenerating it on the same name produces the same
  -- string (slugifyOne in lib/slugifyServiceLocation.ts).
  competitor_name      TEXT NOT NULL,
  competitor_slug      TEXT NOT NULL,
  competitor_url       TEXT,
  -- Free-form JSON of fact key → value, e.g.
  --   {"price_per_visit": "75", "open_24_7": true, "warranty_years": 1}
  -- Validator pulls this verbatim and rejects body claims that don't
  -- trace through one of these keys. Empty JSON {} is valid (no facts
  -- → all rows fail strict validator → no pages generate).
  verified_facts_json  TEXT NOT NULL DEFAULT '{}',
  -- Source URLs that back the facts above. Each entry is a public URL
  -- (Google Business Profile listing, the competitor's own website,
  -- etc). The comparison-page footer lists these as "Sources:" so any
  -- claim is auditable to a public artifact.
  source_urls_json     TEXT NOT NULL DEFAULT '[]',
  -- Provenance metadata for the verified_facts payload. 'manual' = an
  -- operator entered them via admin UI; 'scraper:<source>' = an
  -- automated fetcher pulled them from a declared schema source.
  facts_source         TEXT NOT NULL DEFAULT 'manual',
  facts_updated_at     INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(business_id, competitor_slug)
);
CREATE INDEX IF NOT EXISTS idx_competitors_business
  ON competitors(business_id);

CREATE TABLE IF NOT EXISTS comparison_pages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id          INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  competitor_id        INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  host                 TEXT NOT NULL,
  path                 TEXT NOT NULL,
  body_md              TEXT NOT NULL,
  schema_jsonld        TEXT NOT NULL,
  -- Per-row provenance — which differentiator facts the body cited and
  -- where each came from. Shape:
  --   { "differentiators": [{ "field": "price", "ours": "...", "theirs": "...", "source_us": "...", "source_them": "..." }] }
  -- Rejects on insert when fewer than 3 differentiator rows exist
  -- (low-effort comparisons aren't worth shipping).
  fact_diff_json       TEXT NOT NULL,
  generated_at         INTEGER NOT NULL,
  generator_version    TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','live','retired','rejected')),
  UNIQUE(host, path)
);
CREATE INDEX IF NOT EXISTS idx_comparison_pages_business
  ON comparison_pages(business_id, status);
CREATE INDEX IF NOT EXISTS idx_comparison_pages_host_path_live
  ON comparison_pages(host, path) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_comparison_pages_competitor
  ON comparison_pages(competitor_id);
