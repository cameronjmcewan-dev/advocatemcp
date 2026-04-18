import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll } from "vitest";

describe("GET /admin/audits", () => {
  const tmp = path.join(os.tmpdir(), `admin-audits-${Date.now()}.db`);

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

  async function seedAudit(id: string, opts: Partial<{ cited: number; total: number; ageDays: number; domain: string; category: string }> = {}): Promise<void> {
    const { getDb } = await import("../../db.js");
    const t = { cited: 0, total: 3, ageDays: 0, domain: `${id}.example`, category: "plumber", ...opts };
    const created = new Date(Date.now() - t.ageDays * 24 * 3600 * 1000).toISOString();
    getDb().prepare(
      `INSERT INTO public_audits (id, domain, category, ip_hash, created_at, cost_usd,
        queries_json, cited_count, total_queries) VALUES (?, ?, ?, 'h', ?, 0.025, '[]', ?, ?)`,
    ).run(id, t.domain, t.category, created, t.cited, t.total);
  }

  async function seedFollowup(auditId: string, email: string): Promise<void> {
    const { getDb } = await import("../../db.js");
    getDb().prepare(
      `INSERT INTO audit_followups (audit_id, email, ip_hash, created_at) VALUES (?, ?, 'h', ?)`,
    ).run(auditId, email, new Date().toISOString());
  }

  it("rejects requests without bearer auth", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp()).get("/admin/audits");
    expect(res.status).toBe(401);
  });

  it("lists recent audits with citation_rate, share_url, and emails", async () => {
    await seedAudit("a1", { cited: 1, total: 3 });
    await seedAudit("a2", { cited: 0, total: 3 });
    await seedFollowup("a2", "lead@example.com");
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const a1 = res.body.results.find((r: { id: string }) => r.id === "a1");
    const a2 = res.body.results.find((r: { id: string }) => r.id === "a2");
    expect(a1.citation_rate).toBeCloseTo(0.333, 2);
    expect(a1.share_url).toBe("https://advocatemcp.com/r/a1");
    expect(a1.emails).toEqual([]);
    expect(a2.citation_rate).toBe(0);
    expect(a2.emails).toEqual([{ email: "lead@example.com", captured_at: expect.any(String) }]);
  });

  it("?cited=0 filters to zero-citation audits only", async () => {
    await seedAudit("hot",  { cited: 0, total: 3 });
    await seedAudit("warm", { cited: 1, total: 3 });
    await seedAudit("cold", { cited: 3, total: 3 });
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits?cited=0")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].id).toBe("hot");
  });

  it("?has_email=1 filters to audits with at least one captured email", async () => {
    await seedAudit("captured", { cited: 0 });
    await seedFollowup("captured", "x@y.co");
    await seedAudit("nope", { cited: 0 });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits?has_email=1")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.results[0].id).toBe("captured");
  });

  it("?days respects window — old audits are excluded", async () => {
    await seedAudit("recent", { ageDays: 5 });
    await seedAudit("old",    { ageDays: 60 });
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits?days=14")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.status).toBe(200);
    expect(res.body.range_days).toBe(14);
    expect(res.body.results.map((r: { id: string }) => r.id)).toEqual(["recent"]);
  });

  it("respects limit param (capped at 500)", async () => {
    for (let i = 0; i < 5; i++) await seedAudit(`bulk-${i}`);
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits?limit=3")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
  });

  it("orders by created_at DESC (newest first)", async () => {
    await seedAudit("oldest", { ageDays: 10 });
    await seedAudit("middle", { ageDays: 5 });
    await seedAudit("newest", { ageDays: 0 });
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits")
      .set("Authorization", "Bearer admin-test-key");
    const ids = res.body.results.map((r: { id: string }) => r.id);
    expect(ids[0]).toBe("newest");
    expect(ids[2]).toBe("oldest");
  });
});
