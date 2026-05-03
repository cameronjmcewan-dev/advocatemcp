-- Migration 0014: users.email_verified column.
--
-- Activation flow refactor (May 2 2026 — see
-- docs/superpowers/specs/2026-05-02-activation-flow-design.md):
-- new signups land at email_verified=0 and clear the bit by clicking
-- the activation email. Dashboard middleware refuses to serve until
-- email_verified=1.
--
-- Backfill marks every currently-active paying customer (joined via
-- user_business_access → businesses with a non-null stripe_subscription_id)
-- as already verified, so existing logins don't break. New unpaid /
-- pre-fix records stay at 0 — they hit the splash on next dashboard
-- load and click the activation email to get unstuck.

ALTER TABLE users
  ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET email_verified = 1
WHERE id IN (
  SELECT DISTINCT uba.user_id
  FROM user_business_access uba
  JOIN businesses b ON b.id = uba.business_id
  WHERE b.stripe_subscription_id IS NOT NULL
);
