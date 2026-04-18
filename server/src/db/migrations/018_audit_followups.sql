-- Lead capture for the public GEO audit funnel.
--
-- Each row is a follow-up signup attached to an audit run. The audit
-- itself stores no PII (just an ip_hash for rate limiting). When a
-- visitor enters their email at the bottom of the audit results card,
-- we record it here keyed on the audit_id so we can later:
--
--   1. Send a monthly re-audit ("how has your AI visibility changed?")
--   2. Surface as a sales lead in /admin/audits
--   3. Send onboarding nudges if the lead doesn't convert in N days
--
-- (1) and (3) are not implemented yet — this migration only persists
-- the signal. The follow-up cron is a v1.1 build.
--
-- Unique on (audit_id, email): same audit + same email = no-op (idempotent
-- on resubmit). Different emails on the same audit = both get stored
-- (e.g. an agency owner enters two stakeholder addresses).
--
-- ip_hash mirrors the rate-limit hash on public_audits so we can detect
-- email-spam abuse cheaply (one IP hammering the form with 50 fake
-- addresses). Salt is the same AUDIT_IP_SALT.

CREATE TABLE IF NOT EXISTS audit_followups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id    TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  ip_hash     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  unsubscribed_at TEXT,
  UNIQUE (audit_id, email)
);

CREATE INDEX IF NOT EXISTS idx_audit_followups_email
  ON audit_followups (email);

CREATE INDEX IF NOT EXISTS idx_audit_followups_created
  ON audit_followups (created_at);
