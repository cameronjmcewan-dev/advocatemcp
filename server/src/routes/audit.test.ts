import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

describe("POST /audit/run", () => {
  const tmp = path.join(os.tmpdir(), `audit-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    process.env.AUDIT_IP_SALT = "test-salt";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.AUDIT_IP_SALT;
    vi.restoreAllMocks();
  });

  const baseBody = { domain: "https://acme.example", category: "plumber", location: "Boise, ID" };

  it("returns 503 when PERPLEXITY_API_KEY is unset (fails closed)", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("perplexity_not_configured");
  });

  it("runs 5 Perplexity queries and marks citations correctly when domain appears", async () => {
    const perplexity = await import("../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://other.com", "https://acme.example/about", "https://other2.com"],
      answerText: "Acme is great",
      costUsd:    0.005,
    });

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.audit.total_queries).toBeGreaterThanOrEqual(3);
    expect(res.body.audit.total_queries).toBeLessThanOrEqual(5);
    expect(res.body.audit.cited_count).toBe(res.body.audit.total_queries);
    // Cited rank for acme.example → index 1 (0-based) = rank 2
    expect(res.body.audit.queries[0].cited_rank).toBe(2);
  });

  it("validates inputs: invalid_domain, invalid_category, domain_too_long", async () => {
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();

    const noDomain = await request(app).post("/audit/run").send({ category: "plumber" });
    expect(noDomain.status).toBe(400);
    expect(noDomain.body.error).toBe("invalid_domain");

    const bad = await request(app).post("/audit/run").send({ domain: "not a url", category: "plumber" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_domain");

    const noCat = await request(app).post("/audit/run").send({ domain: "acme.example" });
    expect(noCat.status).toBe(400);
    expect(noCat.body.error).toBe("invalid_category");

    const longCat = await request(app).post("/audit/run").send({
      domain: "acme.example", category: "x".repeat(200),
    });
    expect(longCat.status).toBe(400);
    expect(longCat.body.error).toBe("invalid_category");
  });

  it("caches same (domain, category, location) within 24h — second request is cached:true with no new Perplexity call", async () => {
    const perplexity = await import("../lib/perplexity.js");
    const spy = vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://acme.example"], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();

    const first  = await request(app).post("/audit/run").send(baseBody);
    const callsAfterFirst = spy.mock.calls.length;
    const second = await request(app).post("/audit/run").send(baseBody);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // second did NOT re-call
    expect(second.body.audit.id).toBe(first.body.audit.id);
  });

  it("enforces per-IP rate limit: 4th request within 24h returns 429", async () => {
    const perplexity = await import("../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const ip = "203.0.113.1";

    // Run 3 audits with 3 DIFFERENT domain/category pairs to avoid cache.
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post("/audit/run")
        .set("x-forwarded-for", ip)
        .send({ domain: `a${i}.example`, category: `cat-${i}`, location: "Boise, ID" });
      expect(r.status).toBe(200);
    }

    const fourth = await request(app)
      .post("/audit/run")
      .set("x-forwarded-for", ip)
      .send({ domain: "a4.example", category: "cat-4", location: "Boise, ID" });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe("ip_rate_limited");
    expect(fourth.body.limit).toBe(3);
  });

  it("enforces global daily budget: pre-seeded $5 spend rejects new audits with 503", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    // Pre-seed 200 audit rows totaling $5.005 of spend today.
    const stmt = db.prepare(
      `INSERT INTO public_audits (id, domain, category, ip_hash, created_at, cost_usd,
        queries_json, cited_count, total_queries) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, 0)`
    );
    for (let i = 0; i < 200; i++) {
      stmt.run(`pre-${i}`, `dom${i}.example`, `cat${i}`, `h${i}`, new Date().toISOString(), 0.0251);
    }

    const perplexity = await import("../lib/perplexity.js");
    const spy = vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send({
      domain: "fresh.example", category: "dentist", location: "Boise, ID",
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("daily_budget_exhausted");
    expect(spy).not.toHaveBeenCalled();
  });

  it("normalizes the submitted domain (protocol + trailing slash + case)", async () => {
    const perplexity = await import("../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://Acme.Example/"], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send({
      domain: "HTTPS://Acme.Example/", category: "plumber", location: "Boise, ID",
    });
    expect(res.status).toBe(200);
    expect(res.body.audit.domain).toBe("acme.example");
    // Citation should still match despite case differences.
    expect(res.body.audit.cited_count).toBeGreaterThan(0);
  });

  it("one Perplexity error doesn't abort the batch — remaining queries still run", async () => {
    const perplexity = await import("../lib/perplexity.js");
    let call = 0;
    vi.spyOn(perplexity, "perplexitySearch").mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error("rate limited upstream");
      return { citations: ["https://acme.example"], answerText: "", costUsd: 0.005 };
    });

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.audit.total_queries).toBeGreaterThanOrEqual(3);
    // At least one query should show citations, and the failed one should
    // show cited=false with empty citations.
    const failed = res.body.audit.queries.find((q: { citations: string[] }) => q.citations.length === 0);
    expect(failed).toBeDefined();
  });
});

describe("GET /audit/:id", () => {
  const tmp = path.join(os.tmpdir(), `audit-get-${Date.now()}.db`);
  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    process.env.AUDIT_IP_SALT = "test-salt";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
  });
  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.AUDIT_IP_SALT;
  });

  it("retrieves a previously-stored audit by id", async () => {
    const { getDb } = await import("../db.js");
    getDb().prepare(
      `INSERT INTO public_audits (id, domain, category, location, ip_hash, created_at,
        cost_usd, queries_json, cited_count, total_queries)
        VALUES ('abc123', 'acme.example', 'plumber', 'Boise, ID', 'h', ?, 0.025, ?, 1, 3)`
    ).run(new Date().toISOString(), JSON.stringify([{ query: "q", citations: [], cited: false, cited_rank: null }]));

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get("/audit/abc123");
    expect(res.status).toBe(200);
    expect(res.body.audit.domain).toBe("acme.example");
    expect(res.body.audit.queries).toHaveLength(1);
  });

  it("returns 404 for an unknown id", async () => {
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get("/audit/nope");
    expect(res.status).toBe(404);
  });
});
