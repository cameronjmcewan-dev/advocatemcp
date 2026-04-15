import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 008 — businesses.availability_webhook_url", () => {
  it("adds the nullable column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string; notnull: number }>;
    const col = cols.find(c => c.name === "availability_webhook_url");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("accepts NULL on insert (backward compat)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    // description and services are NOT NULL in the businesses schema (001_initial_schema.sql);
    // id is INTEGER PRIMARY KEY AUTOINCREMENT so omitting it lets SQLite assign it.
    // The point of this test is that availability_webhook_url being absent (NULL)
    // does not block the insert.
    const ins = () => db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key)
      VALUES ('x','X','desc','services','k')
    `).run();
    expect(ins).not.toThrow();
  });
});
