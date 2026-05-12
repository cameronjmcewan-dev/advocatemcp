import type Database from "better-sqlite3";
import cron from "node-cron";
import { getDb } from "../db.js";

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

/**
 * SOC 2 H5 (CC9.2): scheduled PII sweep.
 *
 * Pre-2026-05-12 the reservation-table PII redaction depended on traffic
 * volume — `redactStalePii` was called only on entry to `reserve_slot`. If
 * reservation traffic dropped (off-season, new-tenant ramp, weekend lull),
 * customer-contact PII could outlive its retention window for hours or days.
 * The auditor finding was "the policy text says 24h/7d/90d, the code can't
 * guarantee it" — true.
 *
 * The fix is a node-cron schedule that runs the sweep on a fixed cadence
 * regardless of traffic. Default every 6 hours (matches the original
 * follow-up note in docs/soc2-gap-assessment.md). The per-call invocation
 * stays — both layers are belt-and-suspenders so a missed schedule doesn't
 * widen the window.
 *
 * Override the cadence via env PII_SWEEP_CRON (any valid 5-field cron).
 *
 * Failure mode: a single sweep failure logs to console.error and the next
 * scheduled run retries. We do NOT fall back to a per-call invocation if the
 * schedule fails — `reserve_slot` already invokes `redactStalePii`
 * unconditionally and that path is the existing safety net.
 */
const DEFAULT_PII_SWEEP_CRON = "0 */6 * * *";

export function startPiiSweepSchedule(): void {
  const schedule = process.env.PII_SWEEP_CRON ?? DEFAULT_PII_SWEEP_CRON;
  if (!cron.validate(schedule)) {
    console.warn(`[pii-sweep] invalid cron '${schedule}'; cron NOT scheduled.`);
    return;
  }
  cron.schedule(schedule, () => {
    try {
      const redacted = redactStalePii(getDb());
      const expired = sweepExpiredReservations(getDb());
      console.log(JSON.stringify({
        metric: "pii_sweep_run",
        redacted_rows: redacted,
        expired_rows: expired,
      }));
    } catch (err) {
      console.error("[pii-sweep] sweep threw:", err);
    }
  });
  console.log(`[pii-sweep] scheduled: ${schedule}`);
}
