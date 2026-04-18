import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

describe("admin digest endpoints", () => {
  const tmp = path.join(os.tmpdir(), `p5-admin-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.ADMIN_API_KEY = "admin-test-key";
    process.env.RESEND_API_KEY = "re_test";
    process.env.TOKEN_SIGNING_KEY = "test-signing-key";
    const { _resetDbForTests } = await import("../../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../../db.js");
    getDb();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.ADMIN_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.TOKEN_SIGNING_KEY;
    vi.restoreAllMocks();
  });

  async function seed(slug: string, opts: Partial<{ email: string | null; plan: string; unsub: number; withPoll: boolean }> = {}): Promise<void> {
    const { getDb } = await import("../../db.js");
    const db = getDb();
    const t = { email: `${slug}@example.com`, plan: "pro", unsub: 0, withPoll: true, ...opts };
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       star_rating, review_count, plan, email, digest_unsubscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        slug, `${slug} LLC`, "d", "[]", `k-${slug}`, "plumber", "Boise, ID",
        `https://${slug}.example`, 4.5, 10, t.plan, t.email, t.unsub,
      );
    if (t.withPoll) {
      const basketId = Number(db.prepare(`INSERT INTO competitor_query_baskets
        (slug, query, source, enabled, created_at) VALUES (?, 'q', 'auto', 1, datetime('now'))`).run(slug).lastInsertRowid);
      db.prepare(`INSERT INTO competitor_polls
        (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at,
         our_domain_cited, our_cited_rank, citation_count, cost_usd)
        VALUES (?, ?, 'perplexity', 'q', 0, datetime('now'), 1, 2, 3, 0.005)`).run(slug, basketId);
    }
  }

  it("POST /admin/digest/run-now rejects a request without bearer auth", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp()).post("/admin/digest/run-now");
    expect(res.status).toBe(401);
  });

  it("POST /admin/digest/run-now?dry_run=true reports eligible tenants without sending", async () => {
    await seed("ready");
    await seed("no-email", { email: null });
    const resend = await import("../../lib/resend.js");
    const sendSpy = vi.spyOn(resend, "sendEmail");

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/digest/run-now?dry_run=true")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.considered).toBe(2);
    expect(res.body.would_send).toHaveLength(1);
    expect(res.body.would_send[0].slug).toBe("ready");
    expect(res.body.would_send[0].recipient).toBe("ready@example.com");
    expect(res.body.would_send[0].subject).toContain("cited in 1 of 1");
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].slug).toBe("no-email");
    expect(sendSpy).not.toHaveBeenCalled();

    // Critical: dry-run must not write to radar_digests.
    const { getDb } = await import("../../db.js");
    const { c } = getDb().prepare("SELECT COUNT(*) AS c FROM radar_digests").get() as { c: number };
    expect(c).toBe(0);
  });

  it("POST /admin/digest/run-now triggers the real send path", async () => {
    await seed("real");
    const resend = await import("../../lib/resend.js");
    vi.spyOn(resend, "sendEmail").mockResolvedValue({ id: "msg_real" });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/digest/run-now")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(false);
    expect(res.body.sent).toBe(1);
    expect(res.body.considered).toBe(1);

    const { getDb } = await import("../../db.js");
    const row = getDb().prepare("SELECT resend_id FROM radar_digests WHERE slug='real'").get() as { resend_id: string };
    expect(row.resend_id).toBe("msg_real");
  });

  it("GET /admin/digest/preview/:slug renders HTML for an eligible tenant", async () => {
    await seed("preview");
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/digest/preview/preview")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("preview LLC");
    expect(res.text).toContain("Share of Model");
  });

  it("GET /admin/digest/preview/:slug returns diagnostic JSON for an ineligible tenant", async () => {
    await seed("skipme", { email: null });
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/digest/preview/skipme")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toContain("buildDigest_returned_null");
  });
});
