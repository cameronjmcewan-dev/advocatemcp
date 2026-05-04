import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";
import { _setDbForTesting } from "../../db.js";
import { adminRouter } from "./index.js";

describe("POST /admin/tenants/:slug/purge", () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    process.env.ADMIN_API_KEY = "admin-test-key";
    // requireApiKeyEarly (guarding /admin/faqs + /admin/competitors) checks
    // X-API-Key or Bearer against API_KEY before requireAdmin runs.
    process.env.API_KEY = "server-test-key";
    app = express();
    app.use(express.json());
    app.use(adminRouter);
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
    delete process.env.ADMIN_API_KEY;
    delete process.env.API_KEY;
  });

  it("returns 401 without admin key", async () => {
    const res = await request(app)
      .post("/admin/tenants/any-slug/purge")
      .set("X-API-Key", "server-test-key");
    // No Authorization header → requireAdmin rejects
    expect(res.status).toBe(401);
  });

  it("returns 200 with all-zero counts when slug has no rows", async () => {
    const res = await request(app)
      .post("/admin/tenants/nonexistent-slug/purge")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe("nonexistent-slug");
    // All counts should be zero
    for (const count of Object.values(res.body.deleted as Record<string, number>)) {
      expect(count).toBe(0);
    }
  });

  it("returns 200 with correct counts and removes all tenant rows", async () => {
    const slug = "test-tenant";
    const now = Date.now();

    // Seed business (description + services are NOT NULL in the schema)
    db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key, created_at)
      VALUES (?, 'Test Tenant', 'A test tenant', '[]', 'key-abc', ?)
    `).run(slug, now);

    // Seed 3 queries
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO queries (business_slug, query_text, response_text, crawler_agent)
        VALUES (?, ?, ?, ?)
      `).run(slug, `query ${i}`, `response ${i}`, "GPTBot");
    }

    // Seed 2 reservations
    for (let i = 0; i < 2; i++) {
      db.prepare(`
        INSERT INTO reservations
          (id, business_slug, requested_at, window_start, window_end, status,
           confirmation_token, customer_contact_json, idempotency_key, expires_at)
        VALUES (?, ?, ?, ?, ?, 'held', ?, '{}', ?, ?)
      `).run(`res-${i}`, slug, now, now, now + 3600000, `tok-${i}`, `key-${i}`, now + 900000);
    }

    const res = await request(app)
      .post(`/admin/tenants/${slug}/purge`)
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slug).toBe(slug);
    expect(res.body.deleted.businesses).toBe(1);
    expect(res.body.deleted.queries).toBe(3);
    expect(res.body.deleted.reservations).toBe(2);

    // Verify rows are gone
    const bizCount = (db.prepare("SELECT COUNT(*) as c FROM businesses WHERE slug=?").get(slug) as { c: number }).c;
    expect(bizCount).toBe(0);

    const queryCount = (db.prepare("SELECT COUNT(*) as c FROM queries WHERE business_slug=?").get(slug) as { c: number }).c;
    expect(queryCount).toBe(0);

    const resCount = (db.prepare("SELECT COUNT(*) as c FROM reservations WHERE business_slug=?").get(slug) as { c: number }).c;
    expect(resCount).toBe(0);
  });

  it("is idempotent — second call returns all-zero counts", async () => {
    const slug = "idempotent-tenant";
    const now = Date.now();

    db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key, created_at)
      VALUES (?, 'Idempotent Tenant', 'A test tenant', '[]', 'key-xyz', ?)
    `).run(slug, now);

    db.prepare(`
      INSERT INTO queries (business_slug, query_text, response_text, crawler_agent)
      VALUES (?, 'q', 'r', 'GPTBot')
    `).run(slug);

    const first = await request(app)
      .post(`/admin/tenants/${slug}/purge`)
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(first.status).toBe(200);
    expect(first.body.deleted.businesses).toBe(1);
    expect(first.body.deleted.queries).toBe(1);

    const second = await request(app)
      .post(`/admin/tenants/${slug}/purge`)
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    for (const count of Object.values(second.body.deleted as Record<string, number>)) {
      expect(count).toBe(0);
    }
  });

  it("includes users_note when delete_users=true is passed", async () => {
    const res = await request(app)
      .post("/admin/tenants/no-such-slug/purge?delete_users=true")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(typeof res.body.users_note).toBe("string");
    expect(res.body.users_note).toMatch(/Worker D1/i);
  });

  it("omits users_note when delete_users is not passed", async () => {
    const res = await request(app)
      .post("/admin/tenants/no-such-slug/purge")
      .set("X-API-Key", "server-test-key")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.users_note).toBeUndefined();
  });
});
