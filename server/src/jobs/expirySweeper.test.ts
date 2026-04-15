import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { sweepExpiredReservations } from "./expirySweeper.js";

function seed(db: Database.Database, rows: Array<{ id: string; status: string; expires_at: number }>) {
  const stmt = db.prepare(`
    INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
      status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
    VALUES (?, 'x', 0, 0, 0, ?, 't', '{}', ?, ?)
  `);
  for (const r of rows) stmt.run(r.id, r.status, r.id + "-key", r.expires_at);
}

describe("sweepExpiredReservations", () => {
  it("flips held rows whose expires_at is in the past", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const past = Math.floor(Date.now()/1000) - 10;
    const future = Math.floor(Date.now()/1000) + 10000;
    seed(db, [
      { id: "r1", status: "held", expires_at: past },
      { id: "r2", status: "held", expires_at: future },
      { id: "r3", status: "confirmed", expires_at: past },
    ]);
    const n = sweepExpiredReservations(db);
    expect(n).toBe(1);
    const r1 = db.prepare("SELECT status FROM reservations WHERE id='r1'").get() as { status: string };
    expect(r1.status).toBe("expired");
    const r2 = db.prepare("SELECT status FROM reservations WHERE id='r2'").get() as { status: string };
    expect(r2.status).toBe("held");
    const r3 = db.prepare("SELECT status FROM reservations WHERE id='r3'").get() as { status: string };
    expect(r3.status).toBe("confirmed");
  });

  it("returns 0 and makes no writes when nothing is stale", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    seed(db, [{ id: "r1", status: "held", expires_at: Math.floor(Date.now()/1000) + 1000 }]);
    expect(sweepExpiredReservations(db)).toBe(0);
  });
});
