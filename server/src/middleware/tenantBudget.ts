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

/* Per-tenant default cap. Lowered from $5 to $2 on 2026-04-25 to keep
 * a healthy gross-margin cushion against Base-tier pricing
 * ($149/mo ÷ 30 = $4.96/day revenue per tenant). At $2/day cap the
 * worst-case theoretical spend is $60/mo, which is 30-300x more than
 * any realistic tenant has ever spent on customer-facing endpoints —
 * the cap is an abuse ceiling, not expected usage.
 *
 * Note: this cap currently only covers profile-score + verify-rating.
 * Bot queries (POST /agents/:slug/query, the actual production hot
 * path) are NOT in this bucket — that's a separate concern tracked
 * in docs/followups.md ("bot-query budget tracking"). */
const DEFAULT_PER_TENANT_DAILY_BUDGET_USD = 2;

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

/* persistState was the pre-Bug-2 write-through path. It computed the
 * new state in JS and wrote the whole row back via UPSERT, which was
 * not safe under multi-instance concurrency. The new mutators
 * (reserve/record/release) use atomic conditional UPDATEs against the
 * existing row instead. We keep this helper out of the codepath
 * entirely now so a future contributor doesn't accidentally
 * reintroduce the race by calling it. */

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
 * the response body. Caller MUST call release()/record() to close.
 *
 * Concurrency (Bug 2): pre-fix, the check-then-increment was split
 * into two statements via the in-memory cache:
 *   const projected = s.spentUsd + s.reservedUsd + maxUsd;
 *   if (projected > cap) ...
 *   s.reservedUsd += maxUsd;
 *   persistState(s);
 * Single-process Node serializes all of this synchronously, so a
 * single-instance deploy was safe. Multi-instance (or multi-process,
 * or just two requests landing on different Railway replicas in the
 * same second) was not: each instance had its own cache, both
 * instances passed the cap check, both wrote, last-write-to-SQLite
 * wins, and the actual reserved_usd in SQLite was lower than the sum
 * of what the two instances "thought" they had reserved.
 *
 * Fix: do the check + increment in a single conditional UPDATE so
 * SQLite serializes the operation. The WHERE clause includes the cap
 * predicate; if the row would exceed the cap, the UPDATE matches zero
 * rows and we report "not allowed." After the UPDATE, we sync the
 * in-memory cache from the now-authoritative DB row.
 */
export function reserveForSlug(
  slug: string,
  maxUsd: number,
): { allowed: true } | { allowed: false; remainingUsd: number; capUsd: number } {
  const today = utcDateKey();
  const cap = perTenantCap();
  // Make sure the row exists. rehydrateFromDb is idempotent — INSERTs a
  // zero row if missing, otherwise no-op — and primes the in-memory
  // cache for fast reads.
  const cached = getState(slug);
  try {
    const db = getDb();
    const result = db
      .prepare(
        `UPDATE tenant_budget_state
            SET reserved_usd = reserved_usd + ?,
                updated_at   = ?
          WHERE slug = ? AND date_key = ?
            AND spent_usd + reserved_usd + ? <= ?`,
      )
      .run(maxUsd, new Date().toISOString(), slug, today, maxUsd, cap);
    if (result.changes === 1) {
      // SQL accepted; refresh in-memory cache from the new row so
      // snapshotForSlug() reflects it without a follow-up SELECT.
      cached.reservedUsd += maxUsd;
      return { allowed: true };
    }
    // SQL rejected — read the actual current state to compute the
    // remaining headroom for the caller's error response.
    const row = db
      .prepare(
        "SELECT spent_usd, reserved_usd FROM tenant_budget_state WHERE slug = ? AND date_key = ?",
      )
      .get(slug, today) as { spent_usd: number; reserved_usd: number } | undefined;
    const spent = row?.spent_usd ?? cached.spentUsd;
    const reserved = row?.reserved_usd ?? cached.reservedUsd;
    // Sync cache so subsequent reads aren't stale.
    cached.spentUsd = spent;
    cached.reservedUsd = reserved;
    return {
      allowed: false,
      remainingUsd: Math.max(0, cap - spent - reserved),
      capUsd: cap,
    };
  } catch {
    // DB unavailable: fall back to single-process in-memory check.
    // Loses cross-instance protection but keeps single-instance
    // production / tests working when the DB is mid-bootstrap.
    const projected = cached.spentUsd + cached.reservedUsd + maxUsd;
    if (projected > cap) {
      return {
        allowed: false,
        remainingUsd: Math.max(0, cap - cached.spentUsd - cached.reservedUsd),
        capUsd: cap,
      };
    }
    cached.reservedUsd += maxUsd;
    return { allowed: true };
  }
}

/* Close a reservation with the actual spend amount. Atomic UPDATE so
 * concurrent record() calls accumulate spend correctly (the previous
 * read-modify-write pattern lost increments under multi-instance load
 * in the same way reserve did — see Bug 2 jsdoc above). */
export function recordForSlug(slug: string, reservationMaxUsd: number, actualUsd: number): void {
  const today = utcDateKey();
  const cached = getState(slug);
  try {
    const db = getDb();
    db.prepare(
      `UPDATE tenant_budget_state
          SET reserved_usd = MAX(0, reserved_usd - ?),
              spent_usd    = spent_usd + ?,
              updated_at   = ?
        WHERE slug = ? AND date_key = ?`,
    ).run(reservationMaxUsd, actualUsd, new Date().toISOString(), slug, today);
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
    cached.spentUsd += actualUsd;
  } catch {
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
    cached.spentUsd += actualUsd;
  }
}

/* Release a reservation without recording any spend. Atomic UPDATE
 * (see Bug 2 jsdoc on reserveForSlug). */
export function releaseForSlug(slug: string, reservationMaxUsd: number): void {
  const today = utcDateKey();
  const cached = getState(slug);
  try {
    const db = getDb();
    db.prepare(
      `UPDATE tenant_budget_state
          SET reserved_usd = MAX(0, reserved_usd - ?),
              updated_at   = ?
        WHERE slug = ? AND date_key = ?`,
    ).run(reservationMaxUsd, new Date().toISOString(), slug, today);
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
  } catch {
    cached.reservedUsd = Math.max(0, cached.reservedUsd - reservationMaxUsd);
  }
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
