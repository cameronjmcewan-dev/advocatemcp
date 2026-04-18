import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll } from "vitest";

describe("GET /digest/unsubscribe/:token", () => {
  const tmp = path.join(os.tmpdir(), `p5-unsub-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.TOKEN_SIGNING_KEY = "test-signing-key";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.TOKEN_SIGNING_KEY;
  });

  async function seedTenant(slug: string): Promise<void> {
    const { getDb } = await import("../db.js");
    getDb().prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       star_rating, review_count, plan, email, digest_unsubscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        slug, "Acme LLC", "d", "[]", `k-${slug}`, "plumber", "Boise, ID",
        `https://${slug}.example`, 4.5, 10, "pro", `${slug}@example.com`, 0,
      );
  }

  it("flips digest_unsubscribed=1 and renders confirmation HTML for a valid token", async () => {
    await seedTenant("acme");
    const { mintUnsubscribeToken } = await import("../lib/unsubscribeToken.js");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();

    const token = mintUnsubscribeToken("acme");
    const res = await request(app).get(`/digest/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Unsubscribed");
    expect(res.text).toContain("Acme LLC");

    const { getDb } = await import("../db.js");
    const row = getDb().prepare("SELECT digest_unsubscribed FROM businesses WHERE slug='acme'").get() as { digest_unsubscribed: number };
    expect(row.digest_unsubscribed).toBe(1);
  });

  it("is idempotent — a second visit shows 'already unsubscribed'", async () => {
    await seedTenant("acme2");
    const { mintUnsubscribeToken } = await import("../lib/unsubscribeToken.js");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const token = mintUnsubscribeToken("acme2");

    await request(app).get(`/digest/unsubscribe/${token}`);
    const res2 = await request(app).get(`/digest/unsubscribe/${token}`);
    expect(res2.status).toBe(200);
    expect(res2.text).toContain("Already unsubscribed");
  });

  it("returns 400 for a malformed token", async () => {
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const res = await request(app).get(`/digest/unsubscribe/garbage`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Invalid unsubscribe link");
  });

  it("returns 400 for a token with a tampered signature", async () => {
    await seedTenant("acme3");
    const { mintUnsubscribeToken } = await import("../lib/unsubscribeToken.js");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const token = mintUnsubscribeToken("acme3");
    const dot = token.lastIndexOf(".");
    const tampered = token.slice(0, dot + 1) + "AAAAAAAAAAAAAAAAAAAA";
    const res = await request(app).get(`/digest/unsubscribe/${tampered}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the token is valid but the tenant no longer exists", async () => {
    const { mintUnsubscribeToken } = await import("../lib/unsubscribeToken.js");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const token = mintUnsubscribeToken("never-registered");
    const res = await request(app).get(`/digest/unsubscribe/${token}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain("Account not found");
  });
});
