import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 022: competitor mentions", () => {
  it("adds competitors column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(businesses)`).all() as Array<{ name: string; type: string }>;
    const match = cols.find((c) => c.name === "competitors");
    expect(match).toBeDefined();
    expect(match!.type).toBe("TEXT");
  });

  it("adds competitors_mentioned column to queries", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(queries)`).all() as Array<{ name: string; type: string }>;
    const match = cols.find((c) => c.name === "competitors_mentioned");
    expect(match).toBeDefined();
    expect(match!.type).toBe("TEXT");
  });

  it("creates the competitor-mentions timestamp index", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("idx_queries_competitors_ts");
  });

  it("existing rows survive — additive + nullable", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key)
       VALUES ('t1', 'Test', 'd', 's', '$1', '555', 'k1')`
    ).run();
    db.prepare(
      `INSERT INTO queries (business_slug, query_text, response_text)
       VALUES ('t1', 'hello', 'hi')`
    ).run();
    const biz = db.prepare(`SELECT competitors FROM businesses WHERE slug = 't1'`).get() as { competitors: string | null };
    const q   = db.prepare(`SELECT competitors_mentioned FROM queries LIMIT 1`).get() as { competitors_mentioned: string | null };
    expect(biz.competitors).toBeNull();
    expect(q.competitors_mentioned).toBeNull();
  });
});
