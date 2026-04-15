import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./../migrations.js";

describe("migration 012_click_events_agent", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("adds agent_id and request_id columns to click_events (TEXT NULL)", () => {
    const cols = db
      .prepare("PRAGMA table_info(click_events)")
      .all() as { name: string; notnull: number }[];
    const agent = cols.find((c) => c.name === "agent_id");
    const req = cols.find((c) => c.name === "request_id");
    expect(agent).toBeDefined();
    expect(req).toBeDefined();
    expect(agent!.notnull).toBe(0);
    expect(req!.notnull).toBe(0);
  });

  it("creates index on (agent_id, timestamp)", () => {
    const idx = db
      .prepare("PRAGMA index_list(click_events)")
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_click_events_agent_ts");
  });
});
