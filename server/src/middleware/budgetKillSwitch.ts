/* Daily total spend kill-switch — last-line-of-defense budget cap.
 *
 * Independent of per-tenant + per-admin rate limits, this tracks
 * APPROXIMATE total Anthropic + Places API spend across all endpoints
 * today and refuses cost-incurring requests when the budget threshold
 * is exceeded. Catches:
 *
 *   - Multi-tenant amplification (attacker creates N tenants, each
 *     hitting their own per-tenant limit → unbounded total)
 *   - Logic bugs / misconfigured limits that let through a flood
 *   - Anthropic-side pricing surprises (model upgrade ×3 cost)
 *
 * Configuration:
 *   - DAILY_BUDGET_USD env var sets the cap (default: $25/day).
 *     Override via Railway env to raise/lower without code change.
 *
 * Persistence (Apr 25 2026): the counter is now persisted to SQLite
 * (`budget_state` table, migration 024) so a Railway redeploy / crash
 * / OOM can't silently reset spent_usd and let an attacker who
 * triggered multiple deploys reset the cap multiple times in one day.
 *
 * The in-memory cache is the hot path — every read/mutation goes
 * through it for speed. SQLite is the durability layer: on first call
 * each day we rehydrate from disk; on every mutation we write through.
 * Counter resets at UTC midnight (new date_key, new row in SQLite).
 *
 * Caller pattern: BEFORE the costly operation (e.g. anthropic call),
 * record the EXPECTED max cost via `reserve()`. If the reservation
 * pushes us over budget, reject. If the operation succeeds, the actual
 * cost is later recorded via `record()` to keep the counter accurate
 * (reservations release their stake when actuals are higher or lower).
 *
 * Test note: SQLite writes are best-effort with try/catch. If the DB
 * isn't ready (e.g. very early in startup, or in unit tests that don't
 * call _initSchema), the in-memory state still works — we just lose
 * the durability guarantee for that period. _resetBudgetForTesting
 * clears both layers.
 */

import { getDb } from "../db.js";

const DEFAULT_DAILY_BUDGET_USD = 25;

interface BudgetState {
  dateKey: string;     // YYYY-MM-DD UTC, used to roll over at midnight
  spentUsd: number;    // total spent today
  reservedUsd: number; // pending reservations not yet finalized
}

let state: BudgetState | null = null;

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/* Hydrate state from SQLite for the given date. If no row exists,
 * insert a fresh zero row + return it. Wrapped in try/catch so a DB
 * misconfiguration doesn't take the whole server down — we'll fall
 * back to the in-memory zero state. */
function rehydrateFromDb(dateKey: string): BudgetState {
  const fresh: BudgetState = { dateKey, spentUsd: 0, reservedUsd: 0 };
  try {
    const db = getDb();
    // Make the table exist even if migrations haven't run (safety net for
    // tests + bootstraps that hit the budget before init).
    db.prepare(`
      CREATE TABLE IF NOT EXISTS budget_state (
        date_key      TEXT PRIMARY KEY,
        spent_usd     REAL NOT NULL DEFAULT 0,
        reserved_usd  REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL
      )
    `).run();
    const row = db
      .prepare("SELECT spent_usd, reserved_usd FROM budget_state WHERE date_key = ?")
      .get(dateKey) as { spent_usd: number; reserved_usd: number } | undefined;
    if (row) {
      return { dateKey, spentUsd: row.spent_usd, reservedUsd: row.reserved_usd };
    }
    db.prepare(
      `INSERT INTO budget_state (date_key, spent_usd, reserved_usd, updated_at) VALUES (?,0,0,?)`,
    ).run(dateKey, new Date().toISOString());
    return fresh;
  } catch {
    return fresh;
  }
}

/* persistState was the pre-Bug-2 write-through path: it computed the
 * new (spent, reserved) tuple in JS and UPSERTed the whole row back.
 * Under multi-instance concurrency, two instances could both compute
 * "reserved = old + delta" from a stale `s` and then UPSERT, with the
 * later writer clobbering the earlier delta. The new mutators
 * (reserve/record/release) use atomic conditional UPDATEs against the
 * existing row instead. Helper retained as a no-op stub (with
 * dead-code clearly marked) so importers see the migration intent. */

/* Ensure today's budget_state row exists in SQLite. Called at the top
 * of every mutator so a fresh DB (Railway redeploy, _resetDbForTests
 * between vitest cases, manual migration re-run) starts with a row
 * present. The atomic UPDATEs that follow rely on the row being there
 * — a missing row would make every reserve match-zero and reject. */
function ensureRow(dateKey: string): void {
  try {
    const db = getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS budget_state (
        date_key      TEXT PRIMARY KEY,
        spent_usd     REAL NOT NULL DEFAULT 0,
        reserved_usd  REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL
      )
    `).run();
    db.prepare(
      `INSERT OR IGNORE INTO budget_state (date_key, spent_usd, reserved_usd, updated_at)
       VALUES (?, 0, 0, ?)`,
    ).run(dateKey, new Date().toISOString());
  } catch {
    /* swallow — caller falls back to in-memory path */
  }
}

function getState(): BudgetState {
  const today = utcDateKey();
  if (!state || state.dateKey !== today) {
    state = rehydrateFromDb(today);
  }
  return state;
}

function dailyCap(): number {
  const env = process.env.DAILY_BUDGET_USD;
  const parsed = env ? parseFloat(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
}

/* Reserve room in the budget for an upcoming spend. Returns
 * { allowed: true, reservationId } if budget is available, or
 * { allowed: false, ...} if the reservation would exceed the cap.
 * Caller MUST eventually call release() or record() to close the
 * reservation — orphaned reservations decay at rollover.
 *
 * Concurrency (Bug 2): atomic conditional UPDATE so two instances
 * can't both pass the cap check, both write, last-writer-wins, and
 * silently allow $50 of spend through a $25 cap. The cap predicate
 * lives in the WHERE clause; SQLite serializes the row update. After
 * a successful UPDATE we sync the in-memory cache so snapshot()
 * reflects the new state without another SELECT.
 */
export function reserve(maxUsd: number): { allowed: true; reservationId: string } | { allowed: false; remainingUsd: number; capUsd: number } {
  const today = utcDateKey();
  const cap = dailyCap();
  const cached = getState();
  ensureRow(today);
  try {
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE budget_state
            SET reserved_usd = reserved_usd + ?,
                updated_at   = ?
          WHERE date_key = ?
            AND spent_usd + reserved_usd + ? <= ?`,
      )
      .run(maxUsd, new Date().toISOString(), today, maxUsd, cap);
    if (result.changes === 1) {
      // Best-effort cache update: reflect OUR delta. If another instance
      // raced ahead, our cached.reservedUsd will lag behind reality
      // until the next mutator hits this code path (which re-syncs from
      // the live row on rejection) or until rehydrateFromDb runs at
      // rollover. snapshot() readers may see slightly-stale numbers
      // during that window — the cap enforcement itself is unaffected
      // because the next reserve()'s SQL re-evaluates the predicate.
      cached.reservedUsd += maxUsd;
      return {
        allowed: true,
        reservationId: `${maxUsd}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      };
    }
    const row = db
      .prepare("SELECT spent_usd, reserved_usd FROM budget_state WHERE date_key = ?")
      .get(today) as { spent_usd: number; reserved_usd: number } | undefined;
    const spent = row?.spent_usd ?? cached.spentUsd;
    const reserved = row?.reserved_usd ?? cached.reservedUsd;
    cached.spentUsd = spent;
    cached.reservedUsd = reserved;
    return {
      allowed: false,
      remainingUsd: Math.max(0, cap - spent - reserved),
      capUsd: cap,
    };
  } catch {
    // DB unavailable: fall back to single-process in-memory check.
    const projected = cached.spentUsd + cached.reservedUsd + maxUsd;
    if (projected > cap) {
      return {
        allowed: false,
        remainingUsd: Math.max(0, cap - cached.spentUsd - cached.reservedUsd),
        capUsd: cap,
      };
    }
    cached.reservedUsd += maxUsd;
    return {
      allowed: true,
      reservationId: `${maxUsd}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    };
  }
}

/* Close a reservation with the actual spend. If actualUsd > the
 * reserved amount, the difference still counts (doesn't over-consume
 * the cap retroactively but does flow into next requests' budget).
 * Atomic UPDATE — see Bug 2 jsdoc on reserve(). */
export function record(reservationMaxUsd: number, actualUsd: number): void {
  const today = utcDateKey();
  const cached = getState();
  ensureRow(today);
  try {
    const db = getDb();
    db.prepare(
      `UPDATE budget_state
          SET reserved_usd = MAX(0, reserved_usd - ?),
              spent_usd    = spent_usd + ?,
              updated_at   = ?
        WHERE date_key = ?`,
    ).run(reservationMaxUsd, actualUsd, new Date().toISOString(), today);
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
    cached.spentUsd += actualUsd;
  } catch {
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
    cached.spentUsd += actualUsd;
  }
}

/* Release a reservation without recording any spend (e.g. the
 * call failed before it incurred cost). Atomic UPDATE. */
export function release(reservationMaxUsd: number): void {
  const today = utcDateKey();
  const cached = getState();
  ensureRow(today);
  try {
    const db = getDb();
    db.prepare(
      `UPDATE budget_state
          SET reserved_usd = MAX(0, reserved_usd - ?),
              updated_at   = ?
        WHERE date_key = ?`,
    ).run(reservationMaxUsd, new Date().toISOString(), today);
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
  } catch {
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
  }
}

/* Read-only snapshot for admin / status endpoints. */
export function snapshot(): {
  date_key: string;
  spent_usd: number;
  reserved_usd: number;
  cap_usd: number;
  remaining_usd: number;
} {
  const s = getState();
  const cap = dailyCap();
  return {
    date_key:      s.dateKey,
    spent_usd:     Number(s.spentUsd.toFixed(4)),
    reserved_usd:  Number(s.reservedUsd.toFixed(4)),
    cap_usd:       cap,
    remaining_usd: Number(Math.max(0, cap - s.spentUsd - s.reservedUsd).toFixed(4)),
  };
}

export function _resetBudgetForTesting(): void {
  state = null;
  // Wipe the persisted row too so a test that asserts "fresh budget" sees
  // it. Wrapped — if the DB isn't initialized in this test, just no-op.
  try {
    const db = getDb();
    db.prepare("DELETE FROM budget_state").run();
  } catch {
    /* table absent in tests — fine */
  }
}
