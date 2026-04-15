-- Session 4 (Competitor Radar P3): tenant plan tier + polling tables.
--
-- `businesses.plan` distinguishes 'base' from 'pro' so the cron loop in
-- server/src/jobs/competitorRadar.ts can `WHERE plan='pro'` without a JOIN.
-- The Worker propagates plan tier on registration.
--
-- The three competitor_* tables are the audit trail for Perplexity polls and
-- their citations. Indexes cover the hot read paths exposed by
-- /agents/:slug/competitor-radar/{summary,losses}.

ALTER TABLE businesses ADD COLUMN plan TEXT NOT NULL DEFAULT 'base';

CREATE TABLE IF NOT EXISTS competitor_query_baskets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL,
  query      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK(source IN ('auto','tenant')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(slug, query)
);
CREATE INDEX IF NOT EXISTS idx_cqb_slug ON competitor_query_baskets(slug, enabled);

CREATE TABLE IF NOT EXISTS competitor_polls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL,
  query_basket_id  INTEGER NOT NULL,
  bot              TEXT NOT NULL,
  phrasing         TEXT NOT NULL,
  phrasing_variant INTEGER NOT NULL,
  polled_at        TEXT NOT NULL,
  our_domain_cited INTEGER NOT NULL,
  our_cited_rank   INTEGER,
  citation_count   INTEGER NOT NULL,
  cost_usd         REAL,
  error            TEXT,
  FOREIGN KEY(query_basket_id) REFERENCES competitor_query_baskets(id)
);
CREATE INDEX IF NOT EXISTS idx_cp_slug_polled ON competitor_polls(slug, polled_at DESC);
-- Lost-citation queries widen the index to cover ORDER BY polled_at DESC
-- so the planner can serve summary/losses without a sort.
CREATE INDEX IF NOT EXISTS idx_cp_slug_lost ON competitor_polls(slug, our_domain_cited, polled_at DESC);

CREATE TABLE IF NOT EXISTS competitor_citations (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL,
  rank    INTEGER NOT NULL,
  url     TEXT NOT NULL,
  domain  TEXT NOT NULL,
  title   TEXT,
  FOREIGN KEY(poll_id) REFERENCES competitor_polls(id)
);
CREATE INDEX IF NOT EXISTS idx_cc_poll   ON competitor_citations(poll_id);
CREATE INDEX IF NOT EXISTS idx_cc_domain ON competitor_citations(domain);
