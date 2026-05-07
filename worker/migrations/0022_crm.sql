-- 0022_crm.sql — Phase 5 PR 1 of Traffic Impact data-depth roadmap.
--
-- Per-tenant per-provider CRM OAuth state. Mirrors ga4_connections /
-- gsc_connections's shape so the Settings UI can render a consistent
-- connection-card pattern.
--
-- IMPORTANT: We do NOT store CRM contact data in D1. Each dashboard
-- render fetches contacts live via the CRM API (passthrough). This
-- avoids holding any customer PII at rest in our system. The
-- aggregated daily snapshot (ltv_daily, future PR) will store
-- ROLL-UP numbers only — no individual contacts.
--
-- Refresh token is AES-GCM encrypted via the existing
-- GA4_TOKEN_ENCRYPTION_KEY (the lib is generic per Phase 3 PR 1).
-- One row per (slug, provider) so a tenant can have HubSpot AND
-- Salesforce wired simultaneously.

CREATE TABLE IF NOT EXISTS crm_connections (
  slug                TEXT NOT NULL,
  provider            TEXT NOT NULL,        -- 'hubspot' | 'salesforce'
  refresh_token_enc   TEXT NOT NULL,
  account_id          TEXT,                  -- HubSpot portal_id, Salesforce instance_url
  status              TEXT NOT NULL DEFAULT 'connected',
  last_used_at        TEXT,                  -- last time we fetched contacts on this connection
  last_error          TEXT,
  connected_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, provider),
  FOREIGN KEY (slug) REFERENCES businesses(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crm_connections_status
  ON crm_connections(status, slug);
