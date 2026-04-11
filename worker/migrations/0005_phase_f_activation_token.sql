-- Phase F Part 1: store per-business activation token minted by the
-- Stripe webhook on successful checkout.session.completed.
--
-- Three new columns on the businesses table:
--
--   activation_token     — the signed token string produced by
--                          signActivationToken({slug}). NULL until the
--                          webhook mints one.
--   activation_status    — 'none' (default, pre-mint)
--                          'pending_send' (webhook wrote the token;
--                            operator needs to deliver it)
--                          'sent' (future: email worker flipped it)
--                          'consumed' (future: /api/activate redeemed it)
--   activation_issued_at — ISO timestamp of the mint. Paired with
--                          activation_token so the token's iat/exp
--                          decoded payload can be cross-checked.
--
-- The webhook guarantees mint idempotency via a single atomic
-- `UPDATE ... WHERE slug = ? AND activation_token IS NULL` — a Stripe
-- retry (or a concurrent second webhook invocation) that arrives after
-- the first mint has landed results in meta.changes = 0 and leaves the
-- already-issued token untouched. See Decision 4 in Section 12 of the
-- rearchitecture plan for the full rationale.
--
-- Additive only. Nullable token/issued_at columns plus a NOT NULL
-- DEFAULT 'none' status column mean no existing row can fail
-- validation. No data loss possible.
--
-- Rollback: run migrations/0005_phase_f_activation_token_rollback.sql
-- to DROP the columns and index.
--
-- Run with:
--   cd worker && npx wrangler d1 execute advocatemcp-auth --remote \
--     --file=migrations/0005_phase_f_activation_token.sql

ALTER TABLE businesses ADD COLUMN activation_token TEXT;
ALTER TABLE businesses ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE businesses ADD COLUMN activation_issued_at TEXT;

CREATE INDEX IF NOT EXISTS idx_businesses_activation_status
  ON businesses(activation_status);
