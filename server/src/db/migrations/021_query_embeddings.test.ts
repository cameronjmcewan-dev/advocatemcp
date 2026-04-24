import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 021: query_embeddings", () => {
  it("adds query_embedding + cluster_id columns to queries", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(queries)`).all() as Array<{ name: string; type: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("query_embedding");
    expect(names).toContain("cluster_id");
  });

  it("creates query_clusters table with all required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(query_clusters)`).all() as Array<{ name: string; type: string; notnull: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("id")).toBe(true);
    expect(byName.get("label")?.notnull).toBe(1);
    expect(byName.get("centroid")?.notnull).toBe(1);
    expect(byName.get("size")?.notnull).toBe(1);
    expect(byName.has("representative_query_ids")).toBe(true);
    expect(byName.has("updated_at")).toBe(true);
    expect(byName.has("archived_at")).toBe(true);
  });

  it("creates the cluster indexes", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_queries_cluster_ts");
    expect(names).toContain("idx_query_clusters_active");
  });

  it("is additive — existing rows survive the migration", () => {
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
    const row = db.prepare(`SELECT id, query_embedding, cluster_id FROM queries`).get() as {
      id: number; query_embedding: Buffer | null; cluster_id: number | null;
    };
    expect(row.id).toBe(1);
    expect(row.query_embedding).toBeNull();
    expect(row.cluster_id).toBeNull();
  });
});
