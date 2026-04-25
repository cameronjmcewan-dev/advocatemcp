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

/* Write-through to SQLite. Best-effort — never raises out of the
 * caller's hot path. */
function persistState(s: BudgetState): void {
  try {
    const db = getDb();
    // UPSERT: the row is guaranteed to exist after rehydrateFromDb on
    // the first read of the day, but defensively use INSERT OR REPLACE
    // so a never-initialized table still works.
    db.prepare(`
      INSERT INTO budget_state (date_key, spent_usd, reserved_usd, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date_key) DO UPDATE SET
        spent_usd    = excluded.spent_usd,
        reserved_usd = excluded.reserved_usd,
        updated_at   = excluded.updated_at
    `).run(s.dateKey, s.spentUsd, s.reservedUsd, new Date().toISOString());
  } catch {
    /* swallow — durability is best-effort, in-memory still works */
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
 * reservation — orphaned reservations decay at rollover. */
export function reserve(maxUsd: number): { allowed: true; reservationId: string } | { allowed: false; remainingUsd: number; capUsd: number } {
  const s = getState();
  const cap = dailyCap();
  const projected = s.spentUsd + s.reservedUsd + maxUsd;
  if (projected > cap) {
    return { allowed: false, remainingUsd: Math.max(0, cap - s.spentUsd - s.reservedUsd), capUsd: cap };
  }
  s.reservedUsd += maxUsd;
  persistState(s);
  return { allowed: true, reservationId: `${maxUsd}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
}

/* Close a reservation with the actual spend. If actualUsd > the
 * reserved amount, the difference still counts (doesn't over-consume
 * the cap retroactively but does flow into next requests' budget). */
export function record(reservationMaxUsd: number, actualUsd: number): void {
  const s = getState();
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
  s.spentUsd += actualUsd;
  persistState(s);
}

/* Release a reservation without recording any spend (e.g. the
 * call failed before it incurred cost). */
export function release(reservationMaxUsd: number): void {
  const s = getState();
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
  persistState(s);
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
