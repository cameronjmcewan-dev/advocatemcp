import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { mintContinuationToken } from "../lib/continuationToken.js";

describe("POST /a2a/confirm", () => {
  let app: import("express").Express;
  const KEY = "test-key-a2a";

  beforeAll(async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "t";
    process.env.TOKEN_SIGNING_KEY = KEY;
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();

    const { getDb, __getRawForTest } = await import("../db.js");
    const { applyMigrations } = await import("../db/migrations.js");
    applyMigrations(__getRawForTest() as import("better-sqlite3").Database);
    getDb().prepare(`
      INSERT INTO businesses (slug, name, api_key, description, services)
      VALUES ('acme','Acme','k','d','s')
      ON CONFLICT(slug) DO NOTHING
    `).run();
    getDb().prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r_heldone', 'acme', 1, 1, 2, 'held', 'x', '{}', 'ik-a2a-1', 9999999999)
    `).run();
  });

  it("flips held → confirmed on valid token", async () => {
    const tok = mintContinuationToken(
      { ticket: "r_heldone", business_slug: "acme", scope: "confirm" },
      "test-key-a2a"
    );
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: tok });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reservation_id: "r_heldone", status: "confirmed" });
  });

  it("returns 409 if already confirmed", async () => {
    const tok = mintContinuationToken(
      { ticket: "r_heldone", business_slug: "acme", scope: "confirm" },
      "test-key-a2a"
    );
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: tok });
    expect(res.status).toBe(409);
  });

  it("returns 400 or 401 on bad signature / malformed", async () => {
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: "aaa.bbb" });
    expect([400, 401]).toContain(res.status);
  });

  it("returns 400 on missing token", async () => {
    const res = await request(app).post("/a2a/confirm").send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when token.business_slug does not match the reservation's owner", async () => {
    // Seed a second held reservation belonging to a different tenant.
    const { getDb } = await import("../db.js");
    getDb().prepare(`
      INSERT INTO businesses (slug, name, api_key, description, services)
      VALUES ('other','Other','k2','d','s')
      ON CONFLICT(slug) DO NOTHING
    `).run();
    getDb().prepare(`
      INSERT INTO reservations (id, business_slug, requested_at, window_start, window_end,
        status, confirmation_token, customer_contact_json, idempotency_key, expires_at)
      VALUES ('r_cross', 'other', 1, 1, 2, 'held', 'x', '{}', 'ik-a2a-cross', 9999999999)
    `).run();
    // Mint a token that claims the ticket but lies about the tenant.
    const tok = mintContinuationToken(
      { ticket: "r_cross", business_slug: "acme", scope: "confirm" },
      "test-key-a2a"
    );
    const res = await request(app).post("/a2a/confirm").send({ confirmation_token: tok });
    expect(res.status).toBe(404);
    // Row must remain 'held' — cross-tenant write would be a security bug.
    const row = getDb().prepare(`SELECT status FROM reservations WHERE id='r_cross'`).get() as { status: string };
    expect(row.status).toBe("held");
  });
});

describe("POST /a2a/continue/:token", () => {
  let app: import("express").Express;
  const KEY = "test-key-a2a";

  beforeAll(async () => {
    process.env.DATABASE_PATH ??= ":memory:";
    process.env.ANTHROPIC_API_KEY = "t";
    process.env.TOKEN_SIGNING_KEY = KEY;
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();
  });

  it("returns the decoded payload for a valid continue-scoped token", async () => {
    const tok = mintContinuationToken(
      { ticket: "h_1", business_slug: "acme", scope: "continue" },
      KEY
    );
    const res = await request(app).post(`/a2a/continue/${encodeURIComponent(tok)}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ticket).toBe("h_1");
    expect(res.body.business_slug).toBe("acme");
  });

  it("returns 401 for a confirm-scoped token presented here", async () => {
    const tok = mintContinuationToken(
      { ticket: "h_1", business_slug: "acme", scope: "confirm" },
      KEY
    );
    const res = await request(app).post(`/a2a/continue/${encodeURIComponent(tok)}`).send({});
    expect(res.status).toBe(401);
  });
});
