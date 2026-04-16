import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 015 — businesses.timezone", () => {
  it("adds the nullable column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string; notnull: number; type: string }>;
    const col = cols.find(c => c.name === "timezone");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.type).toBe("TEXT");
  });

  it("accepts NULL on insert (backward compat — existing rows have no timezone)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const ins = () => db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key)
      VALUES ('tz1','TZ One','desc','services','k')
    `).run();
    expect(ins).not.toThrow();
    const row = db.prepare("SELECT timezone FROM businesses WHERE slug = 'tz1'").get() as { timezone: string | null };
    expect(row.timezone).toBeNull();
  });

  it("accepts an IANA timezone string", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key, timezone)
      VALUES ('tz2','TZ Two','desc','services','k','America/Los_Angeles')
    `).run();
    const row = db.prepare("SELECT timezone FROM businesses WHERE slug = 'tz2'").get() as { timezone: string };
    expect(row.timezone).toBe("America/Los_Angeles");
  });
});
