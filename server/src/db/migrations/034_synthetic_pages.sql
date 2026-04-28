-- Migration 034 — Synthetic landing pages (Phase 3 of grey-hat AI optimization layer).
--
-- Per Pro+ tenant, generate up to N pre-rendered (intent × service × location)
-- pages. Each row is a real public URL hosted on either advocatemcp.com (our
-- directory) or the customer's own domain (their SEO authority). The plan's
-- tier-scaled caps (Base=10, Pro=40, Enterprise=150 soft / 500 hard) are
-- enforced in the builder, not the schema — keeping the table flexible.
--
-- Each row stores `source_facts_json` so any claim in `body_md` is auditable
-- back to a specific profile field. Pre-write validator rejects rows where
-- the body cites a number or string not present in source_facts_json. Status
-- starts at 'draft' and only flips to 'live' once the validator passes.
--
-- Apr 28 2026.

CREATE TABLE IF NOT EXISTS synthetic_pages (
  id INTEGER PRIMARY KEY,
  business_id        INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  intent             TEXT NOT NULL CHECK (intent IN (
    'best_top', 'affordable', 'emergency', 'specific_service'
  )),
  service_slug       TEXT NOT NULL,        -- kebab-case from slugifyServiceLocation
  location_slug      TEXT NOT NULL,        -- kebab-case from slugifyServiceLocation
  host               TEXT NOT NULL,        -- 'advocatemcp.com' OR <customer host>
  path               TEXT NOT NULL,        -- e.g. '/best-emergency-plumbing-in-austin'
  title              TEXT NOT NULL,
  body_md            TEXT NOT NULL,        -- markdown rendered to HTML at request time
  schema_jsonld      TEXT NOT NULL,        -- pre-built JSON-LD blocks
  source_facts_json  TEXT NOT NULL,        -- list of profile fields used for provenance
  generated_at       INTEGER NOT NULL,     -- Unix epoch ms
  generator_version  TEXT NOT NULL,        -- prompt hash + model name (drift detection)
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'live', 'retired', 'rejected')),
  UNIQUE(host, path)
);

-- Lookup index for the worker → server path-matcher: every public request
-- to a synthetic page lands here. Filtered to status='live' to keep the
-- index lean (drafts and retireds aren't served).
CREATE INDEX IF NOT EXISTS idx_syn_host_path_live
  ON synthetic_pages(host, path)
  WHERE status = 'live';

-- Per-business lookup for the builder's freshness check + tier-cap enforcement
-- ("how many live pages does this business already have"). Covers all status
-- values so the cap also counts drafts (don't let a backlog of unvalidated
-- drafts let a tenant exceed their cap once they all flip live).
CREATE INDEX IF NOT EXISTS idx_syn_business_status
  ON synthetic_pages(business_id, status);

-- Per-service-slug index for the per-service sub-cap (max 3 pages per
-- service). Used at insert time to refuse the 4th page for a service.
CREATE INDEX IF NOT EXISTS idx_syn_business_service
  ON synthetic_pages(business_id, service_slug);
