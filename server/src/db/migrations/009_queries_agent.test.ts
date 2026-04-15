import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("009_queries_agent migration", () => {
  it("adds agent_id and stage columns to queries", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(queries)").all() as Array<{
      name: string;
      type: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("agent_id");
    expect(names).toContain("stage");
    const agent = cols.find((c) => c.name === "agent_id");
    const stage = cols.find((c) => c.name === "stage");
    expect(agent?.type.toUpperCase()).toBe("TEXT");
    expect(stage?.type.toUpperCase()).toBe("TEXT");
  });

  it("permits NULL on both columns (back-compat with pre-Session-10 INSERTs)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO queries (business_slug, crawler_agent, query_text, response_text, intent)
       VALUES ('x', 'mcp-client', 'q', 'r', 'general')`
    ).run();
    const row = db
      .prepare("SELECT agent_id, stage FROM queries")
      .get() as { agent_id: string | null; stage: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.stage).toBeNull();
  });

  it("is recorded in schema_migrations", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const rows = db
      .prepare("SELECT filename FROM schema_migrations WHERE filename = ?")
      .all("009_queries_agent.sql");
    expect(rows.length).toBe(1);
  });
});
