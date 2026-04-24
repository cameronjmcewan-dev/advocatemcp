import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 020 — queries enrichment", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  it("adds every Layer 1 column to the queries table", () => {
    const cols = db.prepare("PRAGMA table_info(queries)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const expected of [
      "tokens_in", "tokens_out", "cost_cents", "model", "outcome",
      "geo_country", "geo_region", "geo_city", "industry_code", "intent_v2",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("allows INSERTs that leave all new columns NULL — pre-020 code path still works", () => {
    db.prepare(`INSERT INTO businesses (slug, name, description, services, api_key) VALUES ('t1','T1','d','s','k')`).run();
    db.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text) VALUES ('t1', 'q', 'r')`
    ).run();
    const row = db.prepare("SELECT * FROM queries WHERE business_slug = 't1'").get() as Record<string, unknown>;
    expect(row.query_text).toBe("q");
    expect(row.tokens_in).toBeNull();
    expect(row.geo_country).toBeNull();
    expect(row.intent_v2).toBeNull();
  });

  it("accepts a fully-populated enrichment row", () => {
    db.prepare(`INSERT INTO businesses (slug, name, description, services, api_key) VALUES ('t2','T2','d','s','k')`).run();
    db.prepare(
      `INSERT INTO queries (
         business_slug, query_text, response_text,
         tokens_in, tokens_out, cost_cents, model, outcome,
         geo_country, geo_region, geo_city, industry_code, intent_v2
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "t2", "best florist in austin", "resp",
      120, 48, 1, "claude-sonnet-4-6", "click",
      "US", "TX", "Austin", "events", "brand",
    );
    const row = db.prepare("SELECT * FROM queries WHERE business_slug = 't2'").get() as Record<string, unknown>;
    expect(row.tokens_in).toBe(120);
    expect(row.cost_cents).toBe(1);
    expect(row.geo_country).toBe("US");
    expect(row.geo_region).toBe("TX");
    expect(row.industry_code).toBe("events");
    expect(row.intent_v2).toBe("brand");
    expect(row.outcome).toBe("click");
  });

  it("creates the expected read-path indexes", () => {
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queries'`
    ).all() as { name: string }[];
    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_queries_industry_ts");
    expect(names).toContain("idx_queries_intent_v2_ts");
    expect(names).toContain("idx_queries_geo_region");
  });
});
