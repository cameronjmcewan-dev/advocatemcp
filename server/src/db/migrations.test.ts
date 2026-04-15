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

  it("records every applied migration with its filename and applied_at timestamp", () => {
    applyMigrations(db);
    const rows = db
      .prepare("SELECT filename, applied_at FROM schema_migrations ORDER BY filename")
      .all() as { filename: string; applied_at: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.filename).toMatch(/^\d{3}_.+\.sql$/);
      expect(row.applied_at).toBeTruthy();
    }
  });

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

  it("creates the businesses, queries, and click_events tables end-to-end", () => {
    applyMigrations(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("businesses");
    expect(names).toContain("queries");
    expect(names).toContain("click_events");
  });

  it("stamps 001..004 as applied when upgrading a pre-migration DB (prod bootstrap)", () => {
    // Simulate a DB where the old _initSchema had already run: tables present
    // with ALL columns from the pre-migration ALTER TABLE era (so that naively
    // re-running migration 002 would crash on duplicate column), and no
    // schema_migrations table.
    db.exec(`
      CREATE TABLE businesses (
        id INTEGER PRIMARY KEY,
        slug TEXT,
        api_key TEXT,
        category TEXT,
        star_rating REAL,
        review_count INTEGER,
        years_in_business INTEGER,
        top_services TEXT,
        availability TEXT,
        differentiator TEXT,
        service_radius_miles INTEGER,
        certifications TEXT,
        pricing_tier TEXT,
        service_area_keywords TEXT,
        hours_json TEXT,
        services_json_v2 TEXT,
        pricing_json_v2 TEXT,
        credentials_json TEXT,
        ratings_json TEXT,
        differentiators_text TEXT,
        customer_quotes_json TEXT,
        guarantee_text TEXT,
        case_stories_json TEXT,
        lead_routing_json TEXT
      );
      CREATE TABLE queries (id INTEGER PRIMARY KEY, intent TEXT);
      CREATE TABLE click_events (
        id INTEGER PRIMARY KEY,
        destination TEXT,
        query_id INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0
      );
    `);
    applyMigrations(db);
    const applied = listAppliedMigrations(db);
    expect(applied).toContain("001_initial_schema.sql");
    expect(applied).toContain("002_businesses_profile_columns.sql");
    expect(applied).toContain("003_queries_intent.sql");
    expect(applied).toContain("004_click_events.sql");
    // Crucially: no duplicate-column error. Running applyMigrations twice should
    // also be a no-op.
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
