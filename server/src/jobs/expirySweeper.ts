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
