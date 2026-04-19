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

describe("GET /admin/audits/analytics", () => {
  const tmp = path.join(os.tmpdir(), `admin-audits-analytics-${Date.now()}.db`);

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

  async function seedAuditRich(id: string, opts: Partial<{
    cited: number; total: number; ageDays: number; category: string;
    cost: number; domain: string; competitors: string[];
  }> = {}): Promise<void> {
    const { getDb } = await import("../../db.js");
    const t = { cited: 0, total: 3, ageDays: 0, category: "plumber", cost: 0.025, domain: `${id}.example`, competitors: [], ...opts };
    const created = new Date(Date.now() - t.ageDays * 24 * 3600 * 1000).toISOString();
    const queries = t.competitors.length > 0
      ? [{ query: "best plumber", citations: t.competitors.map((d) => `https://${d}/`), cited: false, cited_rank: null }]
      : [];
    getDb().prepare(
      `INSERT INTO public_audits (id, domain, category, ip_hash, created_at, cost_usd,
        queries_json, cited_count, total_queries)
       VALUES (?, ?, ?, 'h', ?, ?, ?, ?, ?)`,
    ).run(id, t.domain, t.category, created, t.cost, JSON.stringify(queries), t.cited, t.total);
  }

  it("rejects without bearer auth", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp()).get("/admin/audits/analytics");
    expect(res.status).toBe(401);
  });

  it("returns headline counts and budget spend", async () => {
    await seedAuditRich("a1", { cited: 0, total: 3, cost: 0.025 });
    await seedAuditRich("a2", { cited: 1, total: 3, cost: 0.03 });
    await seedAuditRich("a3", { cited: 3, total: 3, cost: 0.045 });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits/analytics")
      .set("Authorization", "Bearer admin-test-key");

    expect(res.status).toBe(200);
    expect(res.body.total_audits).toBe(3);
    expect(res.body.total_cost_usd).toBeCloseTo(0.1, 4);
    expect(res.body.by_cited_bucket).toEqual({ zero: 1, partial: 1, all: 1 });
  });

  it("computes email capture rate + total follow-ups", async () => {
    await seedAuditRich("has-email", { cited: 0 });
    await seedAuditRich("no-email", { cited: 0 });
    const { getDb } = await import("../../db.js");
    getDb().prepare(
      `INSERT INTO audit_followups (audit_id, email, ip_hash, created_at) VALUES ('has-email', 'x@y.co', 'h', ?)`,
    ).run(new Date().toISOString());
    getDb().prepare(
      `INSERT INTO audit_followups (audit_id, email, ip_hash, created_at) VALUES ('has-email', 'z@y.co', 'h', ?)`,
    ).run(new Date().toISOString());

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits/analytics")
      .set("Authorization", "Bearer admin-test-key");
    // 1 of 2 audits captured an email → 0.5 rate. 2 total follow-ups.
    expect(res.body.email_capture_rate).toBe(0.5);
    expect(res.body.total_followup_emails).toBe(2);
  });

  it("groups top categories by count", async () => {
    await seedAuditRich("p1", { category: "plumber" });
    await seedAuditRich("p2", { category: "plumber" });
    await seedAuditRich("p3", { category: "plumber" });
    await seedAuditRich("l1", { category: "lawyer" });
    await seedAuditRich("d1", { category: "dentist" });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits/analytics")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.body.top_categories[0]).toEqual({ category: "plumber", count: 3 });
    expect(res.body.top_categories).toHaveLength(3);
  });

  it("aggregates top competitor domains across audits, excluding own-domain and Google Maps shims", async () => {
    await seedAuditRich("a1", { domain: "acme.com", competitors: ["rival.com", "other.com", "acme.com"] });
    await seedAuditRich("a2", { domain: "acme.com", competitors: ["rival.com", "google.com/maps/search/x"] });
    await seedAuditRich("a3", { domain: "different.com", competitors: ["rival.com"] });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits/analytics")
      .set("Authorization", "Bearer admin-test-key");
    const top = res.body.top_competitor_domains_across_audits;
    // rival.com appears in 3 audits; other.com in 1; google.com should NOT
    // appear (only showed up as a maps search shim); acme.com excluded as
    // own-domain for a1/a2.
    expect(top[0]).toEqual({ domain: "rival.com", appears_in: 3 });
    expect(top.find((t: { domain: string }) => t.domain === "google.com")).toBeUndefined();
    expect(top.find((t: { domain: string }) => t.domain === "acme.com")).toBeUndefined();
  });

  it("respects ?days window", async () => {
    await seedAuditRich("recent", { ageDays: 5 });
    await seedAuditRich("old",    { ageDays: 40 });
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .get("/admin/audits/analytics?days=14")
      .set("Authorization", "Bearer admin-test-key");
    expect(res.body.range_days).toBe(14);
    expect(res.body.total_audits).toBe(1);
  });
});
