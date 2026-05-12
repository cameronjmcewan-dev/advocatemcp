-- Migration 0025 — audit_events table
--
-- SOC 2 CC7.2: tamper-evident record of security-relevant events. An auditor
-- asking "show me every API key issuance / admin login / tenant deletion and
-- who did it" must be able to answer this from one table.
--
-- Design:
--   - One row per discrete event. Never UPDATE/DELETE rows from app code.
--   - actor_type is a coarse classification ('user'|'system'|'tenant'|'stripe'|'admin').
--   - actor_id is free-form (user.id, tenant.slug, stripe event id, etc).
--   - event_type uses dotted namespacing ('auth.login_success', 'tenant.api_key_revoked',
--     'stripe.subscription_deleted'). Add new event types without schema change.
--   - metadata_json is opaque to the schema — callers serialise structured context
--     (plan changes, IP geo, Stripe object IDs). MUST NOT contain raw PII or
--     secrets; helper redacts at insertion site.
--   - ip_hash stores SHA-256(client_ip) so we can correlate without storing PII.
--   - request_id is the CF Ray ID where available, for cross-system correlation.
--
-- Apply with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote --file=migrations/0025_audit_events.sql

CREATE TABLE IF NOT EXISTS audit_events (
  id            TEXT PRIMARY KEY,
  occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  event_type    TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  metadata_json TEXT,
  ip_hash       TEXT,
  request_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
  ON audit_events(occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events(actor_type, actor_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_type
  ON audit_events(event_type, occurred_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON audit_events(target_type, target_id, occurred_at);
