-- Per-IP rate-limit counter for the citation-readiness audit endpoint.
--
-- Background: POST /audit/citation-readiness scores any URL the visitor
-- pastes. We cap at READINESS_PER_IP_DAILY_CAP calls per IP per 24h to
-- prevent one visitor from draining the global $25/day kill-switch.
--
-- Pre-Bug-5, the cap counter was stored as synthetic rows in the
-- existing `public_audits` table with category='__readiness__' and
-- domain='__readiness__'. That works mechanically but mixes two
-- different concepts in one table:
--
--   - public_audits = "we ran an audit for a stated business slug"
--   - synthetic readiness markers = "we ran a per-IP counter tick"
--
-- The mixing made admin queries awkward (every COUNT/SELECT had to
-- exclude the synthetic category) and risked accidental disclosure
-- (if an admin export shipped category='__readiness__' rows it would
-- expose the IP-hash counters that were never meant to surface).
--
-- This migration extracts the counter into its own narrow table so the
-- two concerns stay separate. Shape is intentionally minimal — we
-- track WHAT we need for the cap and nothing else, matching the
-- "audit page does not retain per-result data" disclosure story.
--
-- Migration is additive only. The route layer reads + writes against
-- this table on the next deploy. The synthetic rows in public_audits
-- are left in place — they age out at the 24h cutoff and become
-- harmless. A future cleanup migration can DELETE them once we've
-- verified the new path is working in prod.

CREATE TABLE IF NOT EXISTS audit_readiness_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash     TEXT NOT NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- The cap query is "COUNT(*) WHERE ip_hash = ? AND created_at > ?".
-- A composite index on (ip_hash, created_at) makes that O(log n + k)
-- and lets SQLite's range scan stop at the 24h cutoff without a full
-- per-IP scan.
CREATE INDEX IF NOT EXISTS idx_audit_readiness_results_ip_time
  ON audit_readiness_results (ip_hash, created_at);
