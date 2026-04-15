import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations, listAppliedMigrations } from "./migrations.js";

describe("migrations runner", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
  });

  it("creates the schema_migrations bookkeeping table on first run", () => {
    applyMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    expect(row).toBeDefined();
  });

  // TODO(Task 7): un-skip once 001..004 migration files exist.
  it.todo("records every applied migration with its filename and applied_at timestamp");

  it("is idempotent — applying twice does not error and does not re-apply anything", () => {
    applyMigrations(db);
    const first = listAppliedMigrations(db);
    applyMigrations(db);
    const second = listAppliedMigrations(db);
    expect(second).toEqual(first);
  });

  it("applies migrations in numeric prefix order", () => {
    applyMigrations(db);
    const applied = listAppliedMigrations(db);
    const sorted = [...applied].sort();
    expect(applied).toEqual(sorted);
  });

  // TODO(Task 7): un-skip once 001..004 migration files exist.
  it.todo("creates the businesses, queries, and click_events tables end-to-end");
});
