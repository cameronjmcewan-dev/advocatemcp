/* Daily total spend kill-switch — last-line-of-defense budget cap.
 *
 * Independent of per-tenant + per-admin rate limits, this tracks
 * APPROXIMATE total Anthropic API spend across all endpoints today
 * and refuses cost-incurring requests when the budget threshold is
 * exceeded. Catches:
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
 * Counter resets at UTC midnight. In-memory bucket today; if we
 * needed durable enforcement (e.g. survive deploys) we'd persist
 * to D1 with atomic UPDATE counters. For v0 this is a tripwire
 * not a billing gate.
 *
 * Caller pattern: BEFORE the costly operation (e.g. anthropic
 * call), record the EXPECTED max cost via `reserve()`. If the
 * reservation pushes us over budget, reject. If the operation
 * succeeds, the actual cost is later recorded via `record()` to
 * keep the counter accurate (reservations release their stake
 * when actuals are higher or lower).
 */

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

function getState(): BudgetState {
  const today = utcDateKey();
  if (!state || state.dateKey !== today) {
    state = { dateKey: today, spentUsd: 0, reservedUsd: 0 };
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
  return { allowed: true, reservationId: `${maxUsd}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` };
}

/* Close a reservation with the actual spend. If actualUsd > the
 * reserved amount, the difference still counts (doesn't over-consume
 * the cap retroactively but does flow into next requests' budget). */
export function record(reservationMaxUsd: number, actualUsd: number): void {
  const s = getState();
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
  s.spentUsd += actualUsd;
}

/* Release a reservation without recording any spend (e.g. the
 * call failed before it incurred cost). */
export function release(reservationMaxUsd: number): void {
  const s = getState();
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
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
}
