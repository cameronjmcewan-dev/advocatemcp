/* Tests for the per-tenant daily budget cap.
 *
 * Mirrors budgetKillSwitch.test.ts in shape — same in-memory ↔ SQLite
 * write-through pattern, scoped per (slug, day) instead of per-day. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { _setDbForTesting } from "../db.js";
import {
  reserveForSlug,
  recordForSlug,
  releaseForSlug,
  snapshotForSlug,
  topSpendersToday,
  _resetTenantBudgetForTesting,
} from "./tenantBudget.js";

describe("tenantBudget", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tenant_budget_state (
        slug          TEXT NOT NULL,
        date_key      TEXT NOT NULL,
        spent_usd     REAL NOT NULL DEFAULT 0,
        reserved_usd  REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (slug, date_key)
      );
      CREATE INDEX idx_tenant_budget_state_date ON tenant_budget_state (date_key, spent_usd DESC);
    `);
    _setDbForTesting(db);
    _resetTenantBudgetForTesting();
    process.env.PER_TENANT_DAILY_BUDGET_USD = "5";
  });

  afterEach(() => {
    delete process.env.PER_TENANT_DAILY_BUDGET_USD;
    _resetTenantBudgetForTesting();
    db.close();
  });

  it("reserveForSlug() adds to reservedUsd within cap", () => {
    const r = reserveForSlug("alpha", 1.5);
    expect(r.allowed).toBe(true);
    const snap = snapshotForSlug("alpha");
    expect(snap.reserved_usd).toBe(1.5);
    expect(snap.remaining_usd).toBe(3.5);
  });

  it("reserveForSlug() refuses when slug-day projected exceeds cap", () => {
    expect(reserveForSlug("alpha", 4).allowed).toBe(true);
    const r = reserveForSlug("alpha", 2);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.capUsd).toBe(5);
      expect(r.remainingUsd).toBe(1);
    }
  });

  it("isolates spend between tenants", () => {
    expect(reserveForSlug("alpha", 4).allowed).toBe(true);
    // alpha is now near its cap; bravo should be unaffected.
    const r = reserveForSlug("bravo", 4);
    expect(r.allowed).toBe(true);
    expect(snapshotForSlug("alpha").reserved_usd).toBe(4);
    expect(snapshotForSlug("bravo").reserved_usd).toBe(4);
  });

  it("recordForSlug shifts reserved → spent and persists", () => {
    reserveForSlug("alpha", 2);
    recordForSlug("alpha", 2, 1.5);
    const snap = snapshotForSlug("alpha");
    expect(snap.reserved_usd).toBe(0);
    expect(snap.spent_usd).toBeCloseTo(1.5, 5);
    expect(snap.remaining_usd).toBeCloseTo(3.5, 5);
  });

  it("releaseForSlug drops a reservation without spending", () => {
    reserveForSlug("alpha", 3);
    releaseForSlug("alpha", 3);
    const snap = snapshotForSlug("alpha");
    expect(snap.reserved_usd).toBe(0);
    expect(snap.spent_usd).toBe(0);
  });

  it("survives in-memory cache clear (rehydrates from SQLite)", () => {
    reserveForSlug("alpha", 1);
    recordForSlug("alpha", 1, 0.7);
    // Simulate a Railway redeploy: clear cache + re-insert the persisted row
    // (the _reset helper also wipes the row, so we re-insert manually).
    _resetTenantBudgetForTesting();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO tenant_budget_state (slug, date_key, spent_usd, reserved_usd, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("alpha", today, 0.7, 0, new Date().toISOString());
    const snap = snapshotForSlug("alpha");
    expect(snap.spent_usd).toBeCloseTo(0.7, 5);
    expect(snap.remaining_usd).toBeCloseTo(4.3, 5);
  });

  it("rolls over cleanly when date_key changes (yesterday spend ignored)", () => {
    db.prepare(
      "INSERT INTO tenant_budget_state (slug, date_key, spent_usd, reserved_usd, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("alpha", "2020-01-01", 4.99, 0, new Date().toISOString());
    const snap = snapshotForSlug("alpha");
    expect(snap.spent_usd).toBe(0);
    expect(snap.remaining_usd).toBe(5);
    expect(snap.date_key).not.toBe("2020-01-01");
  });

  it("uses default cap when PER_TENANT_DAILY_BUDGET_USD is unset", () => {
    delete process.env.PER_TENANT_DAILY_BUDGET_USD;
    _resetTenantBudgetForTesting();
    // Default lowered from $5 → $2 on 2026-04-25 to keep gross-margin
    // headroom against Base-tier pricing ($149/mo ≈ $4.96/day rev).
    expect(snapshotForSlug("alpha").cap_usd).toBe(2);
  });

  it("topSpendersToday returns rows sorted by spent desc", () => {
    reserveForSlug("alpha", 2);
    recordForSlug("alpha", 2, 1.5);
    reserveForSlug("bravo", 1);
    recordForSlug("bravo", 1, 0.5);
    reserveForSlug("charlie", 4);
    recordForSlug("charlie", 4, 3.0);
    const top = topSpendersToday(5);
    expect(top).toHaveLength(3);
    expect(top[0].slug).toBe("charlie");
    expect(top[0].spent_usd).toBeCloseTo(3.0, 5);
    expect(top[1].slug).toBe("alpha");
    expect(top[2].slug).toBe("bravo");
  });

  /* (Bug 2) Multi-instance race protection: simulate "another instance
   * wrote to SQLite after we hydrated our in-memory cache." Pre-fix,
   * reserveForSlug used (cache value) + maxUsd ≤ cap; the cache was
   * stale so it allowed a reservation that would actually overflow the
   * DB. Post-fix, the conditional UPDATE re-evaluates the predicate
   * against the live DB row, matches zero rows, and we reject. */
  it("rejects when another writer raced ahead in SQLite (Bug 2)", () => {
    // Hydrate cache: alpha has $1 reserved according to our local view.
    expect(reserveForSlug("alpha", 1).allowed).toBe(true);
    expect(snapshotForSlug("alpha").reserved_usd).toBe(1);

    // Another Railway instance writes directly: alpha now has $4.5
    // reserved in the DB. Our in-memory cache still thinks $1.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "UPDATE tenant_budget_state SET reserved_usd = ? WHERE slug = ? AND date_key = ?",
    ).run(4.5, "alpha", today);

    // This reservation should fail: $4.5 + $1 = $5.5 > $5 cap.
    // Pre-Bug-2 behavior would ALLOW (in-memory said $1+$1=$2 ≤ $5).
    const r = reserveForSlug("alpha", 1);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.capUsd).toBe(5);
      // Cache is now refreshed to reflect the racing write.
      expect(snapshotForSlug("alpha").reserved_usd).toBe(4.5);
    }
  });

  it("allows the reservation that exactly hits the cap, rejects the next (Bug 2)", () => {
    // $5 cap exactly: $5 should fit, $0.01 more should not.
    expect(reserveForSlug("alpha", 5).allowed).toBe(true);
    const r = reserveForSlug("alpha", 0.01);
    expect(r.allowed).toBe(false);
  });
});
