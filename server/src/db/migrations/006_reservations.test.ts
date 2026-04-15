import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 006 — reservations", () => {
  it("creates reservations table with the required columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(reservations)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "business_slug",
      "confirmation_token",
      "created_at",
      "customer_contact_json",
      "expires_at",
      "id",
      "idempotency_key",
      "requested_at",
      "status",
      "window_end",
      "window_start",
    ]);
  });

  it("enforces the status CHECK constraint", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insertBad = () => db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r1', 'x', 1, 1, 2, 'bogus', 't', '{}', 'k1', 100)
    `).run();
    expect(insertBad).toThrow(/CHECK/);
  });

  it("enforces UNIQUE on idempotency_key", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r1', 'x', 1, 1, 2, 'held', 't', '{}', 'same-key', 100)
    `).run();
    const dup = () => db.prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r2', 'x', 1, 1, 2, 'held', 't', '{}', 'same-key', 100)
    `).run();
    expect(dup).toThrow(/UNIQUE/);
  });

  it("is idempotent when reapplied (schema_migrations blocks replay)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
