import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 011_agent_reputation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("creates agent_reputation with composite PK on (agent_id, window)", () => {
    const cols = db
      .prepare("PRAGMA table_info(agent_reputation)")
      .all() as { name: string; pk: number }[];
    const pkNames = cols
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pkNames).toEqual(["agent_id", "window"]);
  });

  it("requires window in ('7d','30d')", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_reputation (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score) VALUES ('a','1h',1,0,0,0,0)",
        )
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it("upsert on conflict replaces the row", () => {
    const ins = (n: number) =>
      db
        .prepare(
          "INSERT INTO agent_reputation (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score, updated_at) VALUES ('a','7d', ?, 0, 0, 0, 0, CURRENT_TIMESTAMP) ON CONFLICT(agent_id, window) DO UPDATE SET requests = excluded.requests",
        )
        .run(n);
    ins(5);
    ins(10);
    const r = db
      .prepare(
        "SELECT requests FROM agent_reputation WHERE agent_id='a' AND window='7d'",
      )
      .get() as { requests: number };
    expect(r.requests).toBe(10);
  });
});
