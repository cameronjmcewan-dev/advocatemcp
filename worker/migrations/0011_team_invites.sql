-- Migration 0011 — Team accounts.
--
-- Three additive changes:
--
-- 1. user_business_access.role — per-business role (owner | editor | viewer).
--    Default 'owner' so the backfill leaves existing single-user tenants
--    correctly attributed to their original signup owner. New rows from
--    the team-invite flow set the role explicitly.
--
-- 2. users.pending_invite — flag for invitees who haven't yet set a
--    password. Login path rejects pending users before checking the
--    password hash, so the placeholder hash on these rows can never
--    authenticate.
--
-- 3. users.invite_consumed_at — one-shot guard for the magic-link
--    accept flow. NULL until the invitee clicks their invite link and
--    sets a password; an ISO timestamp once consumed. Re-clicking the
--    link returns 410 Gone instead of letting the password get
--    overwritten.
--
-- Additive only — safe to replay on populated prod D1.

ALTER TABLE user_business_access
  ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner', 'editor', 'viewer'));

ALTER TABLE users
  ADD COLUMN pending_invite INTEGER NOT NULL DEFAULT 0
  CHECK (pending_invite IN (0, 1));

ALTER TABLE users
  ADD COLUMN invite_consumed_at TEXT;

-- Backfill safety: every existing user_business_access row already
-- represents a tenant owner (today's auth model is one-user-one-tenant
-- with the Stripe purchaser), so the column-level DEFAULT 'owner'
-- gives us correct backfill for free. No UPDATE needed.

CREATE INDEX IF NOT EXISTS idx_uba_role
  ON user_business_access(business_id, role);

CREATE INDEX IF NOT EXISTS idx_users_pending_invite
  ON users(pending_invite)
  WHERE pending_invite = 1;
