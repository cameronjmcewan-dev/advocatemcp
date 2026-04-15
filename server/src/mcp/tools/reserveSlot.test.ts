import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";

async function fresh() {
  process.env.DATABASE_PATH = ":memory:";
  process.env.TOKEN_SIGNING_KEY = "test-key-s9";
  const dbMod = await import("../../db.js");
  const db = (dbMod as unknown as { __getRawForTest?: () => Database.Database }).__getRawForTest?.();
  if (db) applyMigrations(db);
  dbMod.getDb().prepare(`
    INSERT INTO businesses (slug, name, description, services, api_key)
    VALUES ('acme','Acme','desc','services','k1')
    ON CONFLICT(slug) DO NOTHING
  `).run();
  return dbMod;
}

describe("reserve_slot", () => {
  it("creates a held reservation and returns a confirmation_token", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const res = await handleReserveSlot({
      slug: "acme",
      window_start: 1776215400,
      window_end: 1776215400 + 1800,
      agent_id: "claude-desktop",
      customer_contact: { name: "Alice", email: "a@x.com" },
      idempotency_key: "k-1",
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content[0] as { text: string }).text) as {
      reservation_id: string; status: string; confirmation_token: string; expires_at: number;
    };
    expect(body.status).toBe("held");
    expect(body.reservation_id).toMatch(/^r_/);
    expect(body.confirmation_token.split(".").length).toBe(2);
    expect(body.expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));
  });

  it("idempotency: same idempotency_key returns the same reservation_id", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const args = {
      slug: "acme", window_start: 1776215400, window_end: 1776215400 + 1800,
      customer_contact: { name: "Alice" }, idempotency_key: "k-dup",
    };
    const a = JSON.parse(((await handleReserveSlot(args)).content[0] as { text: string }).text);
    const b = JSON.parse(((await handleReserveSlot(args)).content[0] as { text: string }).text);
    expect(b.reservation_id).toBe(a.reservation_id);
  });

  it("concurrent idempotency race: both callers get the winner's reservation_id via UNIQUE catch", async () => {
    // Simulate the race by preseeding the UNIQUE row, then calling handleReserveSlot
    // with the same idempotency_key. The SELECT-first branch would return that row;
    // to exercise the INSERT-catch path instead, we delete the row right before
    // the INSERT runs. That's fiddly to synchronize precisely — the cleanest coverage
    // is: issue two calls in parallel with the same key and assert both responses
    // point at the same reservation_id (one went through INSERT, the other through
    // either the SELECT branch or the UNIQUE-catch branch; either way, one row wins).
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const args = {
      slug: "acme",
      window_start: 1776215400,
      window_end: 1776215400 + 1800,
      customer_contact: { name: "Racer" },
      idempotency_key: "k-race",
    };
    const [a, b] = await Promise.all([handleReserveSlot(args), handleReserveSlot(args)]);
    const aBody = JSON.parse((a.content[0] as { text: string }).text) as { reservation_id: string };
    const bBody = JSON.parse((b.content[0] as { text: string }).text) as { reservation_id: string };
    expect(aBody.reservation_id).toBe(bBody.reservation_id);
    // Only one row should exist under this idempotency_key.
    const dbMod = await import("../../db.js");
    const rows = dbMod.getDb().prepare(`SELECT id FROM reservations WHERE idempotency_key = ?`).all("k-race");
    expect(rows.length).toBe(1);
  });

  it("rejects unknown business", async () => {
    await fresh();
    const { handleReserveSlot } = await import("./reserveSlot.js");
    const res = await handleReserveSlot({
      slug: "nope", window_start: 1, window_end: 2,
      customer_contact: {}, idempotency_key: "k-bad",
    });
    expect(res.isError).toBe(true);
  });
});
