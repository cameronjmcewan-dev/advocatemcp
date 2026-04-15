import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 010_agent_requests", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("creates agent_requests table with required columns", () => {
    const cols = db
      .prepare("PRAGMA table_info(agent_requests)")
      .all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "agent_id_source",
      "business_slug",
      "cost_cents",
      "id",
      "latency_ms",
      "outcome_signal",
      "outcome_ts",
      "related_id",
      "request_id",
      "timestamp",
      "tool_called",
    ]);
  });

  it("agent_id is NOT NULL; outcome_signal defaults to 'none'", () => {
    db.prepare(
      `INSERT INTO agent_requests
       (id, agent_id, agent_id_source, business_slug, tool_called, request_id, latency_ms, cost_cents)
       VALUES ('r1', 'cursor', 'header', 'acme', 'query_business_agent', 'req-1', 42, 0)`,
    ).run();
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests WHERE id='r1'")
      .get() as { outcome_signal: string };
    expect(row.outcome_signal).toBe("none");
  });

  it("rejects insert when agent_id is NULL", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_requests
         (id, agent_id_source, business_slug, tool_called, request_id, latency_ms, cost_cents)
         VALUES ('r2', 'header', 'acme', 'query_business_agent', 'req-2', 42, 0)`,
        )
        .run(),
    ).toThrow(/NOT NULL constraint failed: agent_requests.agent_id/);
  });

  it("registers in schema_migrations", () => {
    const row = db
      .prepare(
        "SELECT filename FROM schema_migrations WHERE filename = '010_agent_requests.sql'",
      )
      .get();
    expect(row).toBeDefined();
  });
});
