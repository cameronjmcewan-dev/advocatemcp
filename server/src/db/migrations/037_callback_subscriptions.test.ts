import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 037 — callback_requests + subscriptions + cancellation_policy_text", () => {
  it("adds the nullable cancellation_policy_text column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string; notnull: number; type: string }>;
    const col = cols.find((c) => c.name === "cancellation_policy_text");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
  });

  it("creates callback_requests with the expected columns + constraints", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(callback_requests)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "agent_id",
      "business_slug",
      "contact_email",
      "contact_name",
      "contact_phone",
      "created_at",
      "delivered_via",
      "error",
      "id",
      "preferred_channel",
      "reason",
      "status",
      "updated_at",
      "urgency",
    ]);
  });

  it("rejects invalid status values via CHECK constraint", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insertBad = () => db.prepare(
      `INSERT INTO callback_requests (id, business_slug, status) VALUES (?, ?, ?)`,
    ).run("cb_1", "advocate", "wat");
    expect(insertBad).toThrow();
  });

  it("accepts a full callback_requests row", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(`
      INSERT INTO callback_requests (
        id, business_slug, agent_id, contact_name, contact_email, contact_phone,
        preferred_channel, reason, urgency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("cb_1", "advocate", "claude-desktop", "Cam", "cam@example.com", "+15555550100",
            "phone", "Wants to know weekend availability", "normal");
    const row = db.prepare("SELECT * FROM callback_requests WHERE id = ?")
      .get("cb_1") as { status: string; preferred_channel: string };
    expect(row.status).toBe("pending");
    expect(row.preferred_channel).toBe("phone");
  });

  it("creates subscriptions with UNIQUE(business_slug, contact_email)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const insert = (id: string) => db.prepare(`
      INSERT INTO subscriptions (id, business_slug, contact_email, topics, confirmation_token)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, "advocate", "cam@example.com", "deals,schedule", "tok");
    insert("sub_1");
    expect(() => insert("sub_2")).toThrow();         // dup (slug, email) violates UNIQUE
    // Same email on a different business is fine.
    expect(() =>
      db.prepare(`
        INSERT INTO subscriptions (id, business_slug, contact_email, topics, confirmation_token)
        VALUES (?, ?, ?, ?, ?)
      `).run("sub_3", "other-biz", "cam@example.com", "deals", "tok"),
    ).not.toThrow();
  });

  it("is idempotent — applyMigrations called twice does not throw", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "cancellation_policy_text")).toBe(true);
  });
});
