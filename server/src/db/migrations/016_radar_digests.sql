-- P5 (Radar weekly digest): tenant contact email + digest idempotency + unsubscribe.
--
-- `businesses.email` is nullable because v1 tenants (WCC) were registered before
-- this column existed. Post-migration, the worker's Stripe handler forwards
-- `customer_email` from the checkout session. Tenants with NULL email are
-- skipped at digest time — no crash, just no send.
--
-- `digest_unsubscribed` is a hard opt-out. Set by GET /digest/unsubscribe/:token.
-- Stays set across billing/plan changes; tenants can re-subscribe only via
-- admin action (deliberate — CAN-SPAM/GDPR friendliness).
--
-- `radar_digests` is the idempotency table. Unique on (slug, window_start_iso)
-- so a retry after a transient Resend failure can't double-send. `sent_at`
-- records the first successful send; `resend_id` stores Resend's returned
-- message id for deliverability debugging; `error` captures the failure string
-- for attempts that never succeeded (row still written for audit).
--
-- No indexes beyond the implicit PRIMARY KEY — read path is always by
-- (slug, window_start) lookup, which the unique index covers.

ALTER TABLE businesses ADD COLUMN email TEXT;
ALTER TABLE businesses ADD COLUMN digest_unsubscribed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS radar_digests (
  slug              TEXT NOT NULL,
  window_start_iso  TEXT NOT NULL,
  window_end_iso    TEXT NOT NULL,
  sent_at           TEXT,
  resend_id         TEXT,
  error             TEXT,
  PRIMARY KEY (slug, window_start_iso)
);
