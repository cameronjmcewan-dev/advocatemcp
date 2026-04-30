-- Migration 037: tool surface expansion (Apr 30 2026 strategy doc, Phase 1).
--
-- Backs three new MCP tools:
--   - get_cancellation_policy → reads businesses.cancellation_policy_text
--   - request_callback        → writes callback_requests rows
--   - subscribe_to_updates    → writes subscriptions rows
--
-- get_credentials reuses the existing businesses.credentials_json column
-- (no schema change required) so it's not represented here.

-- ─── businesses.cancellation_policy_text ────────────────────────────────────
--
-- Free-text cancellation / refund policy surfaced to AI agents via
-- get_cancellation_policy. Distinct from guarantee_text (a positive
-- promise like "satisfaction guaranteed or your money back") because
-- cancellation policy is the operational rule the agent needs to quote
-- when a user asks "what if I need to cancel?". Both are tenant-edited
-- via the existing PATCH /agents/:slug/profile flow.
--
-- Default NULL → cold-start tenants behave correctly (the tool returns a
-- generic "no policy on file; contact the business directly" rather than
-- erroring or fabricating a policy).
ALTER TABLE businesses ADD COLUMN cancellation_policy_text TEXT;

-- ─── callback_requests ──────────────────────────────────────────────────────
--
-- Async lead-capture surface. AI agent → request_callback tool → row
-- written here → tenant-side notification fires (SMS/email via the
-- same lead_routing_json infrastructure as initiate_handoff). The
-- request_callback tool is a friendlier-shaped wrapper around the
-- existing handoff(mode='human') primitive but also surfaces the lead
-- as its own queryable surface for tenant dashboards (e.g. "you have
-- 3 unanswered callback requests").
--
-- Why a new table vs reusing handoffs: handoffs is reservation-scoped
-- (a handoff is "this booking needs human review"). Callback requests
-- come BEFORE any reservation — typically when an agent decides the
-- user's question can't be answered without human contact. The
-- existing handoffs table doesn't fit that pre-booking shape cleanly.
--
-- Status lifecycle: pending → notified (lead_routing dispatched) →
-- acknowledged (tenant marked as seen) → completed (tenant called
-- back). Terminal failure: failed (lead_routing returned error).
CREATE TABLE IF NOT EXISTS callback_requests (
  id              TEXT PRIMARY KEY,                        -- ULID
  business_slug   TEXT NOT NULL,
  agent_id        TEXT,                                    -- caller-asserted, may be NULL
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  preferred_channel TEXT CHECK(preferred_channel IN ('phone','email','sms','any')),
  reason          TEXT,                                    -- free text the agent passes through
  urgency         TEXT CHECK(urgency IN ('low','normal','high','emergency')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','notified','acknowledged','completed','failed')),
  delivered_via   TEXT,                                    -- 'twilio_sms' | 'resend_email' | NULL
  error           TEXT,                                    -- on status='failed', the reason
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_callback_requests_slug_created
  ON callback_requests(business_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_callback_requests_status
  ON callback_requests(status, created_at);

-- ─── subscriptions ──────────────────────────────────────────────────────────
--
-- Opt-in updates from a business: schedule changes, deals, new services.
-- Email-only in v1 (SMS adds Twilio cost + 10DLC compliance overhead;
-- defer until tenant demand justifies it).
--
-- Confirmation flow: pending → confirmed (user clicked confirmation
-- link with HMAC-signed token) → active. Inactive states: revoked
-- (user unsubscribed), bounced (email bounced 3+ times — auto-revoked).
--
-- Topics: free-form list (e.g., 'deals', 'schedule_changes', 'new_services'),
-- stored as comma-separated string. JSON would be cleaner but adds
-- query complexity for "which subscribers want topic X" queries — the
-- string form lets us LIKE-search efficiently.
--
-- The dispatch worker (sending the actual updates) is intentionally
-- NOT shipped in this migration — it's a separate cron job that reads
-- this table. v1 of subscribe_to_updates writes the row + returns the
-- confirmation token; activation + dispatch land in a follow-up.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,                     -- ULID
  business_slug      TEXT NOT NULL,
  agent_id           TEXT,                                 -- caller-asserted, may be NULL
  contact_email      TEXT NOT NULL,                        -- email-only in v1
  topics             TEXT NOT NULL,                        -- comma-separated tags
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','confirmed','revoked','bounced')),
  confirmation_token TEXT NOT NULL,                        -- HMAC-signed (slug, sub_id, exp)
  confirmed_at       TEXT,
  revoked_at         TEXT,
  bounce_count       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- Dedup: a single email can subscribe ONCE per business (re-subscribe
  -- updates topics + resets to pending if revoked).
  UNIQUE(business_slug, contact_email)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_slug_status
  ON subscriptions(business_slug, status);
