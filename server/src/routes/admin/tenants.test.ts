import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll } from "vitest";

describe("POST /admin/tenants/:slug/email", () => {
  const tmp = path.join(os.tmpdir(), `admin-tenants-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.ADMIN_API_KEY = "admin-test-key";
    const { _resetDbForTests } = await import("../../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.ADMIN_API_KEY;
  });

  async function seedTenant(slug: string, email: string | null = null): Promise<void> {
    const { getDb } = await import("../../db.js");
    getDb().prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        slug, "Acme", "d", "[]", `k-${slug}`, "plumber", "Boise, ID", 4.5, 10, "base", email,
      );
  }

  it("rejects without bearer auth", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/tenants/acme/email")
      .send({ email: "owner@acme.example" });
    expect(res.status).toBe(401);
  });

  it("sets a missing email and returns changes=1", async () => {
    await seedTenant("acme", null);
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "owner@acme.example" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, slug: "acme", email: "owner@acme.example", changes: 1 });

    const { getDb } = await import("../../db.js");
    const row = getDb().prepare("SELECT email FROM businesses WHERE slug='acme'").get() as { email: string };
    expect(row.email).toBe("owner@acme.example");
  });

  it("is idempotent — setting the same email twice returns changes=0", async () => {
    await seedTenant("acme", "owner@acme.example");
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "owner@acme.example" });
    expect(res.status).toBe(200);
    expect(res.body.changes).toBe(0);
  });

  it("normalizes email to lowercase + trim", async () => {
    await seedTenant("acme", null);
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "  Owner@ACME.Example  " });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("owner@acme.example");
  });

  it("returns 404 for an unknown slug", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/tenants/nonexistent/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "a@b.co" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tenant_not_found");
  });

  it("returns 400 for missing or malformed email", async () => {
    await seedTenant("acme", null);
    const { createTestApp } = await import("../../testApp.js");
    const app = createTestApp();

    const noEmail = await request(app)
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({});
    expect(noEmail.status).toBe(400);

    const badShape = await request(app)
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "not-an-email" });
    expect(badShape.status).toBe(400);

    const tooLong = await request(app)
      .post("/admin/tenants/acme/email")
      .set("Authorization", "Bearer admin-test-key")
      .send({ email: "a".repeat(250) + "@b.co" });
    expect(tooLong.status).toBe(400);
  });
});
