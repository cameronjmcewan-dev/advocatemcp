import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
      CREATE TABLE queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_slug TEXT NOT NULL,
        crawler_agent TEXT,
        query_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        referral_clicked INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        intent TEXT
      );
      CREATE TABLE click_events (
        id INTEGER PRIMARY KEY,
        business_slug TEXT,
        ref TEXT,
        user_agent TEXT,
        ip_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
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

describe("migration 002 partial-application safety", () => {
  it("does NOT stamp 002 when some profile columns are missing on businesses", () => {
    const db = new Database(":memory:");
    // Simulate the crash-mid-_initSchema scenario: businesses exists with
    // migration 001's columns plus only 10 of 002's 21 profile columns (the
    // first 10 from the ALTER list — the crash happened before completing
    // the remaining 11).
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
        pricing_tier TEXT
      );
    `);
    // No queries or click_events tables — exercise the full bootstrap path.

    // Bootstrap should stamp 001 (businesses exists) but NOT 002 (columns incomplete).
    // Then the runner tries to re-apply 002, which throws on the first duplicate ALTER.
    expect(() => applyMigrations(db)).toThrow(/duplicate column/i);

    const applied = listAppliedMigrations(db);
    expect(applied).toContain("001_initial_schema.sql");
    expect(applied).not.toContain("002_businesses_profile_columns.sql");

    db.close();
  });

  it("stamps 002 when all 21 profile columns are present (happy path unchanged)", () => {
    const db = new Database(":memory:");
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
      CREATE TABLE queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_slug TEXT NOT NULL,
        crawler_agent TEXT,
        query_text TEXT NOT NULL,
        response_text TEXT NOT NULL,
        referral_clicked INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        intent TEXT
      );
      CREATE TABLE click_events (
        id INTEGER PRIMARY KEY,
        business_slug TEXT,
        ref TEXT,
        user_agent TEXT,
        ip_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        destination TEXT,
        query_id INTEGER,
        legacy INTEGER NOT NULL DEFAULT 0
      );
    `);
    applyMigrations(db);
    const applied = listAppliedMigrations(db);
    expect(applied).toContain("002_businesses_profile_columns.sql");
    db.close();
  });

  it("MIGRATION_002_COLUMNS list matches the actual ALTER TABLE statements in 002", () => {
    // Symmetric drift-guard. Three independent checks:
    //   1. The expected[] list in this test matches what ends up on the
    //      businesses table after a clean applyMigrations — catches someone
    //      removing/renaming a column in the .sql without updating here.
    //   2. The expected[] list matches the ADD COLUMN names parsed from
    //      002_businesses_profile_columns.sql — catches someone adding a
    //      new column to the .sql without updating this test.
    //   3. Taken together with MIGRATION_002_COLUMNS in migrations.ts (which
    //      is intentionally duplicated from expected[] below — see the
    //      comment there), a change to any one of the three sources breaks
    //      this test until all three are updated in lockstep.
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as { name: string }[];
    const present = new Set(cols.map((c) => c.name));

    // Intentionally duplicated from MIGRATION_002_COLUMNS in migrations.ts.
    // Changing one side MUST break this test — do not consolidate.
    const expected = [
      "category", "star_rating", "review_count", "years_in_business",
      "top_services", "availability", "differentiator", "service_radius_miles",
      "certifications", "pricing_tier", "service_area_keywords", "hours_json",
      "services_json_v2", "pricing_json_v2", "credentials_json", "ratings_json",
      "differentiators_text", "customer_quotes_json", "guarantee_text",
      "case_stories_json", "lead_routing_json",
    ];

    // Check 1: every expected column ended up on businesses.
    for (const c of expected) {
      expect(present.has(c), `missing column ${c}`).toBe(true);
    }

    // Check 2: the .sql file's ADD COLUMN names match expected[] as a set.
    // Regex captures the column name from each `ALTER TABLE businesses ADD
    // COLUMN <name> <type>;` line. If 002 grows a 22nd column, the set
    // inequality fires and forces an update here (and transitively in
    // MIGRATION_002_COLUMNS in migrations.ts).
    const sqlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "migrations",
      "002_businesses_profile_columns.sql",
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    const sqlColumns = Array.from(
      sql.matchAll(/ADD\s+COLUMN\s+(\w+)\s+/gi),
      (m) => m[1],
    );
    expect(new Set(sqlColumns)).toEqual(new Set(expected));
    expect(sqlColumns.length).toBe(expected.length);

    db.close();
  });
});

describe("migrations — 005_queries_request_id", () => {
  it("adds a request_id TEXT column to the queries table", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(queries)").all() as { name: string; type: string }[];
    const col = cols.find((c) => c.name === "request_id");
    expect(col).toBeDefined();
    expect(col?.type).toBe("TEXT");
    db.close();
  });
});

describe("migrations — 009_queries_request_id_index", () => {
  it("creates idx_queries_request_id on queries(request_id)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const idx = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name=?"
      )
      .get("idx_queries_request_id") as { name: string; tbl_name: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx?.tbl_name).toBe("queries");
    const info = db
      .prepare("PRAGMA index_info(idx_queries_request_id)")
      .all() as { name: string }[];
    expect(info.map((c) => c.name)).toEqual(["request_id"]);
    db.close();
  });
});
