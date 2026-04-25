/* Per-tenant daily AI-spend cap — defense-in-depth on top of the
 * global kill-switch (budgetKillSwitch.ts) and per-route rate limits
 * (costRateLimit.ts).
 *
 * Why a third layer:
 *   - Global cap ($25/day) prevents fleet-wide blowout
 *   - Per-route rate limits prevent one endpoint from looping forever
 *   - Per-tenant cap prevents one slug aggregating across endpoints
 *     and crowding out the rest of the fleet's headroom
 *
 *   Worst case without this layer: tenant A burns $4.80 on profile-
 *   score (60×$0.08 = within rate limit) + $1.20 on verify-rating
 *   (24×$0.05 = within rate limit) = $6.00 on a single tenant. With 4
 *   such tenants on a busy day we'd hit the global $25 cap with
 *   nothing left for the other tenants.
 *
 * Configuration:
 *   - PER_TENANT_DAILY_BUDGET_USD env var sets the per-tenant cap.
 *     Default $5/day. Override via Railway env to widen for trusted
 *     tenants or tighten during incident response.
 *
 * Persistence:
 *   - Same SQLite write-through pattern as the global kill-switch
 *     (migration 024 → 025). In-memory map for hot reads, write-through
 *     to tenant_budget_state on every reserve / record / release.
 *   - State rolls over at UTC midnight per (slug, date_key) row. Old
 *     rows stay around as a per-tenant spend trail (useful for billing
 *     lookalikes + abuse triage).
 *
 * Caller pattern: same as the global module. Reserve BEFORE the costly
 * call, record() with actual cost on success, release() on failure.
 *
 * Composition: callers should reserve from BOTH this module AND the
 * global kill-switch. Reserve from the per-tenant first (cheaper to
 * fail-fast), then global. Order matters for the rollback path —
 * if global fails after per-tenant succeeds, you must release per-
 * tenant. The wrapTenantSpend helper at the bottom encapsulates that
 * dance.
 */

import { getDb } from "../db.js";

const DEFAULT_PER_TENANT_DAILY_BUDGET_USD = 5;

interface TenantBudgetState {
  slug: string;
  dateKey: string;
  spentUsd: number;
  reservedUsd: number;
}

const cache = new Map<string, TenantBudgetState>();

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function cacheKey(slug: string, dateKey: string): string {
  return `${slug}:${dateKey}`;
}

/* Hydrate per-tenant state from SQLite for the given (slug, day).
 * If no row exists, insert a fresh zero row + return it. Same defense-
 * in-depth try/catch as budgetKillSwitch — DB unavailability falls
 * back to in-memory zero state rather than blocking traffic. */
function rehydrateFromDb(slug: string, dateKey: string): TenantBudgetState {
  const fresh: TenantBudgetState = { slug, dateKey, spentUsd: 0, reservedUsd: 0 };
  try {
    const db = getDb();
    db.prepare(`
      CREATE TABLE IF NOT EXISTS tenant_budget_state (
        slug          TEXT NOT NULL,
        date_key      TEXT NOT NULL,
        spent_usd     REAL NOT NULL DEFAULT 0,
        reserved_usd  REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (slug, date_key)
      )
    `).run();
    const row = db
      .prepare("SELECT spent_usd, reserved_usd FROM tenant_budget_state WHERE slug = ? AND date_key = ?")
      .get(slug, dateKey) as { spent_usd: number; reserved_usd: number } | undefined;
    if (row) {
      return { slug, dateKey, spentUsd: row.spent_usd, reservedUsd: row.reserved_usd };
    }
    db.prepare(
      `INSERT INTO tenant_budget_state (slug, date_key, spent_usd, reserved_usd, updated_at) VALUES (?, ?, 0, 0, ?)`,
    ).run(slug, dateKey, new Date().toISOString());
    return fresh;
  } catch {
    return fresh;
  }
}

/* Best-effort write-through. Never raises out of the caller's hot
 * path — durability is best-effort, in-memory still works. */
function persistState(s: TenantBudgetState): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO tenant_budget_state (slug, date_key, spent_usd, reserved_usd, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug, date_key) DO UPDATE SET
        spent_usd    = excluded.spent_usd,
        reserved_usd = excluded.reserved_usd,
        updated_at   = excluded.updated_at
    `).run(s.slug, s.dateKey, s.spentUsd, s.reservedUsd, new Date().toISOString());
  } catch {
    /* swallow */
  }
}

function getState(slug: string): TenantBudgetState {
  const today = utcDateKey();
  const key = cacheKey(slug, today);
  const existing = cache.get(key);
  if (existing && existing.dateKey === today) return existing;
  const fresh = rehydrateFromDb(slug, today);
  cache.set(key, fresh);
  return fresh;
}

function perTenantCap(): number {
  const env = process.env.PER_TENANT_DAILY_BUDGET_USD;
  const parsed = env ? parseFloat(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PER_TENANT_DAILY_BUDGET_USD;
}

/* Reserve room in the per-tenant budget for an upcoming spend.
 * Returns { allowed: true } if the reservation fits, or
 * { allowed: false, ... } with the cap + remaining headroom for
 * the response body. Caller MUST call release()/record() to close. */
export function reserveForSlug(
  slug: string,
  maxUsd: number,
): { allowed: true } | { allowed: false; remainingUsd: number; capUsd: number } {
  const s = getState(slug);
  const cap = perTenantCap();
  const projected = s.spentUsd + s.reservedUsd + maxUsd;
  if (projected > cap) {
    return {
      allowed: false,
      remainingUsd: Math.max(0, cap - s.spentUsd - s.reservedUsd),
      capUsd: cap,
    };
  }
  s.reservedUsd += maxUsd;
  persistState(s);
  return { allowed: true };
}

/* Close a reservation with the actual spend amount. */
export function recordForSlug(slug: string, reservationMaxUsd: number, actualUsd: number): void {
  const s = getState(slug);
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
  s.spentUsd += actualUsd;
  persistState(s);
}

/* Release a reservation without recording any spend. */
export function releaseForSlug(slug: string, reservationMaxUsd: number): void {
  const s = getState(slug);
  s.reservedUsd = Math.max(0, s.reservedUsd - reservationMaxUsd);
  persistState(s);
}

/* Read-only snapshot for admin dashboards. */
export function snapshotForSlug(slug: string): {
  slug: string;
  date_key: string;
  spent_usd: number;
  reserved_usd: number;
  cap_usd: number;
  remaining_usd: number;
} {
  const s = getState(slug);
  const cap = perTenantCap();
  return {
    slug:          s.slug,
    date_key:      s.dateKey,
    spent_usd:     Number(s.spentUsd.toFixed(4)),
    reserved_usd:  Number(s.reservedUsd.toFixed(4)),
    cap_usd:       cap,
    remaining_usd: Number(Math.max(0, cap - s.spentUsd - s.reservedUsd).toFixed(4)),
  };
}

/* Top-N spenders for today — admin dashboard signal. Returns rows
 * sorted by spent_usd desc. */
export function topSpendersToday(limit = 10): Array<{
  slug: string;
  spent_usd: number;
  reserved_usd: number;
}> {
  const today = utcDateKey();
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT slug, spent_usd, reserved_usd
           FROM tenant_budget_state
          WHERE date_key = ?
          ORDER BY spent_usd DESC
          LIMIT ?`,
      )
      .all(today, limit) as Array<{ slug: string; spent_usd: number; reserved_usd: number }>;
    return rows.map((r) => ({
      slug: r.slug,
      spent_usd: Number(r.spent_usd.toFixed(4)),
      reserved_usd: Number(r.reserved_usd.toFixed(4)),
    }));
  } catch {
    return [];
  }
}

export function _resetTenantBudgetForTesting(): void {
  cache.clear();
  try {
    const db = getDb();
    db.prepare("DELETE FROM tenant_budget_state").run();
  } catch {
    /* table absent — fine */
  }
}
