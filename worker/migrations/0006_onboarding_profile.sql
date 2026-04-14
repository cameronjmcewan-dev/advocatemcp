-- 9-step wizard: add JSON blob columns to D1 businesses + onboarding_drafts table.
-- ALTER TABLE ADD COLUMN is idempotent-safe in D1 only via wrangler's skip-on-error;
-- we use IF NOT EXISTS semantics by checking table_info first in application code.

ALTER TABLE businesses ADD COLUMN hours_json TEXT;
ALTER TABLE businesses ADD COLUMN services_json_v2 TEXT;
ALTER TABLE businesses ADD COLUMN pricing_json_v2 TEXT;
ALTER TABLE businesses ADD COLUMN credentials_json TEXT;
ALTER TABLE businesses ADD COLUMN ratings_json TEXT;
ALTER TABLE businesses ADD COLUMN differentiators_text TEXT;
ALTER TABLE businesses ADD COLUMN customer_quotes_json TEXT;
ALTER TABLE businesses ADD COLUMN guarantee_text TEXT;
ALTER TABLE businesses ADD COLUMN case_stories_json TEXT;
ALTER TABLE businesses ADD COLUMN lead_routing_json TEXT;

CREATE TABLE IF NOT EXISTS onboarding_drafts (
  email TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onboarding_drafts_updated
  ON onboarding_drafts (updated_at DESC);
