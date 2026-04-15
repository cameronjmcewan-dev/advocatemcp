import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 007 — handoffs", () => {
  it("creates handoffs table with required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(handoffs)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "business_slug",
      "continuation_url",
      "created_at",
      "delivered_via",
      "handshake_token",
      "id",
      "mode",
      "reservation_id",
      "ticket_id",
    ]);
  });

  it("rejects mode outside ('human','agent')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const bad = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode) VALUES ('h1','x','other')
    `).run();
    expect(bad).toThrow(/CHECK/);
  });

  it("allows delivered_via NULL (for mode='agent')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const good = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode) VALUES ('h1','x','agent')
    `).run();
    expect(good).not.toThrow();
  });

  it("rejects delivered_via outside ('sms','email')", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const bad = () => db.prepare(`
      INSERT INTO handoffs (id, business_slug, mode, delivered_via) VALUES ('h1','x','human','carrier-pigeon')
    `).run();
    expect(bad).toThrow(/CHECK/);
  });
});
