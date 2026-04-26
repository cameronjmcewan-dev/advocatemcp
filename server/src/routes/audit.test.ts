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

  it("returns 503 when NEITHER provider key is set (fails closed)", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("no_provider_configured");
  });

  it("falls back to OpenAI when only OPENAI_API_KEY is set", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    const openai = await import("../lib/openai.js");
    const spy = vi.spyOn(openai, "openaiSearch").mockResolvedValue({
      citations: ["https://acme.example"],
      answerText: "Acme",
      costUsd: 0.03,
    });

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(200);
    expect(res.body.audit.cited_count).toBe(res.body.audit.total_queries);
    expect(spy).toHaveBeenCalled();
  });

  it("prefers Perplexity when both provider keys are set (cheaper path)", async () => {
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    process.env.OPENAI_API_KEY = "sk-test";
    const perplexity = await import("../lib/perplexity.js");
    const openai = await import("../lib/openai.js");
    const ppxSpy = vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://acme.example"], answerText: "", costUsd: 0.005,
    });
    const oaiSpy = vi.spyOn(openai, "openaiSearch");

    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).post("/audit/run").send(baseBody);
    expect(res.status).toBe(200);
    expect(ppxSpy).toHaveBeenCalled();
    expect(oaiSpy).not.toHaveBeenCalled();
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
});

describe("POST /audit/:id/follow-up — lead capture", () => {
  const tmp = path.join(os.tmpdir(), `audit-followup-${Date.now()}.db`);
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

  async function seedAudit(id: string): Promise<void> {
    const { getDb } = await import("../db.js");
    getDb().prepare(
      `INSERT INTO public_audits (id, domain, category, ip_hash, created_at,
        cost_usd, queries_json, cited_count, total_queries)
        VALUES (?, 'acme.example', 'plumber', 'h', ?, 0.025, '[]', 0, 3)`,
    ).run(id, new Date().toISOString());
  }

  it("captures an email and persists to audit_followups", async () => {
    await seedAudit("aud1");
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp())
      .post("/audit/aud1/follow-up")
      .send({ email: "lead@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, audit_id: "aud1", email: "lead@example.com", created: true });

    const { getDb } = await import("../db.js");
    const row = getDb().prepare("SELECT email FROM audit_followups WHERE audit_id='aud1'").get() as { email: string };
    expect(row.email).toBe("lead@example.com");
  });

  it("is idempotent — same email same audit returns created=false on second call", async () => {
    await seedAudit("aud2");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const r1 = await request(app).post("/audit/aud2/follow-up").send({ email: "x@y.co" });
    const r2 = await request(app).post("/audit/aud2/follow-up").send({ email: "x@y.co" });
    expect(r1.body.created).toBe(true);
    expect(r2.body.created).toBe(false);
  });

  it("normalizes email to lowercase + trim", async () => {
    await seedAudit("aud3");
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp())
      .post("/audit/aud3/follow-up")
      .send({ email: "  Owner@ACME.Co  " });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("owner@acme.co");
  });

  it("rejects invalid email shapes", async () => {
    await seedAudit("aud4");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    expect((await request(app).post("/audit/aud4/follow-up").send({})).status).toBe(400);
    expect((await request(app).post("/audit/aud4/follow-up").send({ email: "nope" })).status).toBe(400);
    expect((await request(app).post("/audit/aud4/follow-up").send({ email: "a".repeat(250) + "@b.co" })).status).toBe(400);
  });

  it("returns 404 if audit_id doesn't exist", async () => {
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp())
      .post("/audit/nonexistent/follow-up")
      .send({ email: "x@y.co" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("audit_not_found");
  });

  it("rate-limits an IP at the configured cap (10/day)", async () => {
    await seedAudit("aud5");
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const ip = "203.0.113.99";
    for (let i = 0; i < 10; i++) {
      const r = await request(app)
        .post("/audit/aud5/follow-up")
        .set("x-forwarded-for", ip)
        .send({ email: `user${i}@example.com` });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post("/audit/aud5/follow-up")
      .set("x-forwarded-for", ip)
      .send({ email: "spam@example.com" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("ip_rate_limited");
  });

  it("returns 404 for GET /audit/:id when id is unknown", async () => {
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp()).get("/audit/nope");
    expect(res.status).toBe(404);
  });
});

/* (Bug 5) The citation-readiness route used to track its per-IP cap by
 * inserting synthetic category='__readiness__' rows into public_audits.
 * Migration 027 adds a dedicated audit_readiness_results table; the
 * route now writes there and the cap query unions both tables for the
 * 24h rollout window. These tests pin both halves of that union. */
describe("POST /audit/citation-readiness — per-IP cap (Bug 5)", () => {
  const tmp = path.join(os.tmpdir(), `audit-readiness-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.AUDIT_IP_SALT = "test-salt";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
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
    delete process.env.AUDIT_IP_SALT;
    delete process.env.ANTHROPIC_API_KEY;
    vi.restoreAllMocks();
  });

  async function mockReadiness(): Promise<void> {
    const lib = await import("../lib/citationReadiness.js");
    vi.spyOn(lib, "scoreCitationReadiness").mockResolvedValue({
      ok:               true,
      url:              "https://example.com/",
      byte_length:      1024,
      fetched_at:       new Date().toISOString(),
      score:            7,
      would_cite:       true,
      reasoning:        "stubbed",
      signals_present:  [],
      signals_missing:  [],
      improvements:     [],
      cost_usd:         0.04,
    });
  }

  it("writes successful runs to audit_readiness_results, not public_audits", async () => {
    await mockReadiness();
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp())
      .post("/audit/citation-readiness")
      .set("x-forwarded-for", "203.0.113.10")
      .send({ url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { getDb } = await import("../db.js");
    const db = getDb();
    const newRow = db.prepare("SELECT COUNT(*) AS c FROM audit_readiness_results").get() as { c: number };
    const oldRow = db.prepare("SELECT COUNT(*) AS c FROM public_audits WHERE category = '__readiness__'").get() as { c: number };
    expect(newRow.c).toBe(1);
    expect(oldRow.c).toBe(0);
  });

  it("enforces the 5/IP/day cap via the new table", async () => {
    await mockReadiness();
    const { createTestApp } = await import("../testApp.js");
    const app = createTestApp();
    const ip = "203.0.113.20";
    // First 5 succeed.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/audit/citation-readiness")
        .set("x-forwarded-for", ip)
        .send({ url: "https://example.com" });
      expect(res.status).toBe(200);
    }
    // 6th hits the cap.
    const denied = await request(app)
      .post("/audit/citation-readiness")
      .set("x-forwarded-for", ip)
      .send({ url: "https://example.com" });
    expect(denied.status).toBe(429);
    expect(denied.body.reason).toBe("ip_rate_limited");
  });

  it("counts legacy synthetic public_audits rows during the rollout window", async () => {
    // Simulate a tenant who hit the cap on the OLD code path: 5 rows
    // in public_audits with category='__readiness__'. With the new
    // code, a 6th call from that IP should still be rejected because
    // the cap query unions both tables. Once the legacy rows age past
    // the 24h window they stop counting and the union becomes a
    // no-op — that's the intended migration glide.
    const { getDb } = await import("../db.js");
    const db = getDb();
    // Compute the same ip_hash the route would: sha256(ip|salt) → first 16 hex.
    // Use the same salt set in beforeEach.
    const ip = "203.0.113.30";
    const cryptoMod = await import("crypto");
    // Match what route's hashIp() emits: full sha256 hex, no slice.
    const ipHash = cryptoMod.createHash("sha256")
      .update(`${ip}|test-salt`).digest("hex");

    const stmt = db.prepare(
      `INSERT INTO public_audits
        (id, domain, category, location, ip_hash,
         queries_json, cited_count, total_queries, error,
         cost_usd, created_at)
       VALUES (?, ?, '__readiness__', NULL, ?, '[]', 0, 0, NULL, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) {
      stmt.run(`legacy-${i}`, "__readiness__", ipHash, 0.04, new Date().toISOString());
    }

    await mockReadiness();
    const { createTestApp } = await import("../testApp.js");
    const res = await request(createTestApp())
      .post("/audit/citation-readiness")
      .set("x-forwarded-for", ip)
      .send({ url: "https://example.com" });
    expect(res.status).toBe(429);
    expect(res.body.reason).toBe("ip_rate_limited");
  });
});
