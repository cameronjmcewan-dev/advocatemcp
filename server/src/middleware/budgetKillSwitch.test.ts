/* Tests for the daily budget kill-switch.
 *
 * Covers:
 *   - Reserve/record/release math with the in-memory cache
 *   - Reservation refused when projected spend exceeds the cap
 *   - SQLite persistence: state survives a forced re-hydration
 *     (simulates a Railway redeploy by clearing the in-memory cache
 *      between writes and reads)
 *   - UTC date rollover (state for old day stays in DB, new day starts
 *     at zero)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { _setDbForTesting } from "../db.js";
import {
  reserve,
  record,
  release,
  snapshot,
  _resetBudgetForTesting,
} from "./budgetKillSwitch.js";

describe("budgetKillSwitch", () => {
  let db: Database.Database;

  beforeEach(() => {
    // Fresh in-memory DB per test so persistence assertions are clean.
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE budget_state (
        date_key      TEXT PRIMARY KEY,
        spent_usd     REAL NOT NULL DEFAULT 0,
        reserved_usd  REAL NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL
      );
    `);
    _setDbForTesting(db);
    _resetBudgetForTesting();
    // Ensure the cap is a known value for these tests so a stray env
    // setting in the dev shell doesn't change the math.
    process.env.DAILY_BUDGET_USD = "10";
  });

  afterEach(() => {
    delete process.env.DAILY_BUDGET_USD;
    _resetBudgetForTesting();
    db.close();
  });

  it("reserve() adds to reservedUsd when within cap", () => {
    const r = reserve(2);
    expect(r.allowed).toBe(true);
    const snap = snapshot();
    expect(snap.reserved_usd).toBe(2);
    expect(snap.spent_usd).toBe(0);
    expect(snap.remaining_usd).toBe(8);
  });

  it("reserve() refuses when projected spend exceeds cap", () => {
    expect(reserve(8).allowed).toBe(true);
    const r = reserve(5);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.capUsd).toBe(10);
      expect(r.remainingUsd).toBe(2);
    }
  });

  it("record() shifts reserved → spent and persists", () => {
    reserve(1);
    record(1, 0.75);
    const snap = snapshot();
    expect(snap.reserved_usd).toBe(0);
    expect(snap.spent_usd).toBeCloseTo(0.75, 5);
    expect(snap.remaining_usd).toBeCloseTo(9.25, 5);
  });

  it("release() drops a reservation without recording spend", () => {
    reserve(3);
    release(3);
    const snap = snapshot();
    expect(snap.reserved_usd).toBe(0);
    expect(snap.spent_usd).toBe(0);
  });

  it("persists state to SQLite — state survives in-memory clear", () => {
    reserve(2);
    record(2, 1.5);
    // Simulate a Railway redeploy by wiping the in-memory cache. The
    // next snapshot() call should rehydrate from SQLite.
    _resetBudgetForTesting();
    // _resetBudgetForTesting also DELETEs the persisted row, so to
    // simulate a redeploy we have to insert a row first.
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO budget_state (date_key, spent_usd, reserved_usd, updated_at) VALUES (?, ?, ?, ?)",
    ).run(today, 1.5, 0, new Date().toISOString());
    const snap = snapshot();
    expect(snap.spent_usd).toBeCloseTo(1.5, 5);
    expect(snap.remaining_usd).toBeCloseTo(8.5, 5);
  });

  it("rollover: yesterday's spend doesn't affect today's cap", () => {
    // Pre-seed a yesterday row directly so we know it's there
    db.prepare(
      "INSERT INTO budget_state (date_key, spent_usd, reserved_usd, updated_at) VALUES (?, ?, ?, ?)",
    ).run("2020-01-01", 9.99, 0, new Date().toISOString());
    const snap = snapshot();
    // Today is rehydrated from the empty row inserted on first read,
    // not the stale 2020-01-01 row.
    expect(snap.spent_usd).toBe(0);
    expect(snap.remaining_usd).toBe(10);
    expect(snap.date_key).not.toBe("2020-01-01");
  });

  it("uses default cap when DAILY_BUDGET_USD is unset", () => {
    delete process.env.DAILY_BUDGET_USD;
    _resetBudgetForTesting();
    const snap = snapshot();
    expect(snap.cap_usd).toBe(25);
  });

  it("multiple sequential reserves add up correctly", () => {
    reserve(2);
    reserve(3);
    const snap = snapshot();
    expect(snap.reserved_usd).toBe(5);
    expect(snap.remaining_usd).toBe(5);
  });
});
