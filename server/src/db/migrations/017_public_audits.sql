-- Public GEO Audit storage (acquisition funnel).
--
-- Each row is one audit run — initiated from the public /audit page by
-- someone who has NOT signed up. We persist for three reasons:
--
--   1. Per-IP rate limiting: cap one visitor to 3 audits per day to stop
--      casual abuse without requiring CAPTCHA.
--   2. 24h cache: the same (domain, category, location) triple returns
--      the cached result so reloads don't re-spend on Perplexity.
--   3. Lead funnel: every audit is a warm acquisition signal we can
--      follow up on (the domain is self-disclosed).
--
-- Daily global budget is enforced by summing cost_usd for today.
--
-- ip_hash: SHA-256 of (cf-connecting-ip || AUDIT_IP_SALT). Never store
-- raw IPs. Salt is per-deploy so rotating it invalidates all prior
-- per-IP rate-limit state if we ever need to reset abuse.
--
-- queries_json: JSON array of { query, citations[], cited }.

CREATE TABLE IF NOT EXISTS public_audits (
  id             TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  category       TEXT NOT NULL,
  location       TEXT,
  ip_hash        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  cost_usd       REAL NOT NULL,
  queries_json   TEXT NOT NULL,
  cited_count    INTEGER NOT NULL,
  total_queries  INTEGER NOT NULL,
  error          TEXT
);

-- Per-IP rate limit lookup — covers the WHERE ip_hash = ? AND created_at > ?
-- query path.
CREATE INDEX IF NOT EXISTS idx_public_audits_ip_created
  ON public_audits(ip_hash, created_at DESC);

-- Cache lookup — covers the WHERE domain = ? AND category = ?
-- (AND location...) AND created_at > ? query path.
CREATE INDEX IF NOT EXISTS idx_public_audits_lookup
  ON public_audits(domain, category, location, created_at DESC);

-- Daily budget aggregate.
CREATE INDEX IF NOT EXISTS idx_public_audits_created
  ON public_audits(created_at);
