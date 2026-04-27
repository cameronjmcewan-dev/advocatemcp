-- Migration 031 — Monthly performance review email dispatch.
--
-- Mirrors the radar_digests pattern (migration 016 + 019) so the
-- monthlyPerformanceReview cron can clone weeklyDigest's idempotency
-- + retry logic without inventing new infrastructure.
--
-- Primary key (slug, window_start_iso) means INSERT OR IGNORE is the
-- canonical "send-once-per-month" guard. Re-invoking the cron is safe;
-- second send for the same month is a no-op.
--
-- Retry support (attempts / last_attempt_at / next_attempt_at) lets the
-- retry cron pick up rows where Resend 5xx'd or the upstream timed out.
-- Exponential backoff: 5min → 30min → 2h → 12h → terminal (5 attempts).

CREATE TABLE IF NOT EXISTS monthly_review_dispatch (
  slug              TEXT NOT NULL,
  window_start_iso  TEXT NOT NULL,
  window_end_iso    TEXT NOT NULL,
  sent_at           TEXT,
  resend_id         TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TEXT,
  next_attempt_at   TEXT,
  PRIMARY KEY (slug, window_start_iso)
);

-- Retry-cron index: only scan unsent rows whose next_attempt_at has
-- come due. Partial index keeps it tiny (fully-sent rows are excluded).
CREATE INDEX IF NOT EXISTS idx_monthly_review_retry
  ON monthly_review_dispatch(next_attempt_at)
  WHERE sent_at IS NULL;
