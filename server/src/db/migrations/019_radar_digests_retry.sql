-- P5 follow-up (Phase F Part 3): async retry for failed digest email sends.
--
-- Before this migration, a transient Resend error (5xx, rate limit) meant
-- the tenant's weekly digest row was written with `error` and `sent_at=NULL`
-- and stayed that way until the following Monday's cron — a full week of
-- retention signal lost for one transient failure.
--
-- The retry design:
--
--   On failed send, weeklyDigest.ts sets:
--     attempts        = 1
--     last_attempt_at = <iso now>
--     next_attempt_at = <iso now + 2 min>
--
--   A separate cron (`retryPendingDigests`) runs every 2 min, picks up rows
--   with sent_at IS NULL AND next_attempt_at <= now, re-sends, and on
--   failure bumps attempts + reschedules with exponential backoff:
--     2 → +10 min,  3 → +1h,  4 → +6h,  5 → terminal (next_attempt_at=NULL).
--
--   On success, sent_at is set, error cleared, next_attempt_at nulled.
--
-- Index shape: the retry query is
--   WHERE sent_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
-- Partial indexes aren't uniformly supported across better-sqlite3 builds we
-- target, so a plain covering index on (next_attempt_at) gives the planner
-- enough to seek; the additional NULL filters sit on top at negligible cost
-- given the row count (one row per tenant per week, not growing fast).

ALTER TABLE radar_digests ADD COLUMN attempts        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE radar_digests ADD COLUMN last_attempt_at TEXT;
ALTER TABLE radar_digests ADD COLUMN next_attempt_at TEXT;

CREATE INDEX IF NOT EXISTS idx_rd_retry ON radar_digests(next_attempt_at);
