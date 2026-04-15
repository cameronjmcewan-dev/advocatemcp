import type Database from "better-sqlite3";

/**
 * Synchronous sweep: flip status='held' → 'expired' for any reservation whose
 * expires_at is in the past. Returns number of rows updated.
 * Called on entry to reserve_slot so holds don't pile up; no cron needed in v1.
 */
export function sweepExpiredReservations(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  const res = db.prepare(`
    UPDATE reservations SET status='expired' WHERE status='held' AND expires_at < ?
  `).run(now);
  return res.changes;
}

/**
 * PII retention sweep — replaces `customer_contact_json` with a self-documenting
 * redaction sentinel on reservations whose contact data is no longer needed
 * for operational purposes. Sentinel form: `{"redacted":true,"redacted_at":<unix>}`.
 *
 * Why a sentinel and not NULL: the column is `NOT NULL` in 006_reservations.sql.
 * Changing that to nullable is a separate migration; the sentinel preserves the
 * existing constraint, is still parseable JSON, and the `redacted_at` timestamp
 * is auditable evidence of when retention policy fired.
 *
 * Policy (documented in AGENTS.md, Session 9):
 * - status='held'      AND expires_at < now - 24h:  the hold lapsed and was
 *                                                    never confirmed; no
 *                                                    operational reason to
 *                                                    keep the contact details.
 * - status='expired'   AND expires_at < now - 7d:   sweeper has flipped the
 *                                                    row; one-week buffer
 *                                                    covers any in-flight
 *                                                    appeal/recovery flow.
 * - status='confirmed' AND window_end < now - 90d:  service was rendered 90+
 *                                                    days ago; standard
 *                                                    customer-callback window
 *                                                    has closed. Tune per
 *                                                    industry if needed.
 *
 * `rejected` rows are left alone: v1 doesn't store contact JSON on reject,
 * so there's nothing to redact, but the explicit no-op is documented for the
 * day a future tool starts populating contact on rejected rows.
 *
 * Called alongside sweepExpiredReservations on entry to reserve_slot so PII
 * decay happens passively as the reservations table is touched. No cron in v1.
 *
 * Returns number of rows redacted. Idempotent: WHERE clause filters out rows
 * whose JSON already starts with the redaction sentinel, so a re-run is a no-op.
 */
export function redactStalePii(db: Database.Database): number {
  const now = Math.floor(Date.now() / 1000);
  const HOUR = 3600;
  const DAY = 86400;
  const heldCutoff = now - 24 * HOUR;
  const expiredCutoff = now - 7 * DAY;
  const confirmedCutoff = now - 90 * DAY;
  const sentinel = JSON.stringify({ redacted: true, redacted_at: now });
  const res = db.prepare(`
    UPDATE reservations
       SET customer_contact_json = ?
     WHERE customer_contact_json NOT LIKE '%"redacted":true%'
       AND (
         (status = 'held'      AND expires_at < ?) OR
         (status = 'expired'   AND expires_at < ?) OR
         (status = 'confirmed' AND window_end < ?)
       )
  `).run(sentinel, heldCutoff, expiredCutoff, confirmedCutoff);
  return res.changes;
}
