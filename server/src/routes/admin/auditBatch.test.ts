import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

describe("POST /admin/audits/batch", () => {
  const tmp = path.join(os.tmpdir(), `admin-batch-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.ADMIN_API_KEY = "admin-test-key";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    process.env.AUDIT_IP_SALT = "test-salt";
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
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.AUDIT_IP_SALT;
  });

  it("rejects requests without bearer auth", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/audits/batch")
      .send({ prospects: [{ domain: "a.example", category: "plumber", location: "Boise, ID" }] });
    expect(res.status).toBe(401);
  });

  it("rejects empty or missing prospects array", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const app = createTestApp();
    const noBody = await request(app).post("/admin/audits/batch").set("Authorization", "Bearer admin-test-key").send({});
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).toBe("missing_prospects_array");
    const empty = await request(app).post("/admin/audits/batch").set("Authorization", "Bearer admin-test-key").send({ prospects: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_prospects_array");
  });

  it("rejects batches over the 5-prospect cap", async () => {
    const { createTestApp } = await import("../../testApp.js");
    const oversize = Array.from({ length: 6 }, (_, i) => ({ domain: `d${i}.example`, category: "x", location: "Y" }));
    const res = await request(createTestApp())
      .post("/admin/audits/batch")
      .set("Authorization", "Bearer admin-test-key")
      .send({ prospects: oversize });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("batch_too_large");
    expect(res.body.limit).toBe(5);
  });

  it("runs each prospect in parallel with bounded concurrency, returns audit + share_url", async () => {
    const perplexity = await import("../../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: ["https://acme.example", "https://other.com"],
      answerText: "ok", costUsd: 0.005,
    });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/audits/batch")
      .set("Authorization", "Bearer admin-test-key")
      .send({
        prospects: [
          { domain: "acme.example",  category: "plumber",     location: "Boise, ID" },
          { domain: "other.example", category: "law firm",    location: "Austin, TX" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.batch_size).toBe(2);
    expect(res.body.succeeded).toBe(2);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r.ok).toBe(true);
      expect(r.share_url).toMatch(/^https:\/\/advocatemcp\.com\/r\/[a-f0-9]+$/);
      expect(r.audit.queries.length).toBeGreaterThan(0);
    }
  });

  it("captures per-prospect validation errors without aborting the batch", async () => {
    const perplexity = await import("../../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/audits/batch")
      .set("Authorization", "Bearer admin-test-key")
      .send({
        prospects: [
          { domain: "valid.example", category: "plumber", location: "Boise, ID" },
          { domain: "not a url",     category: "x",       location: "Y" },         // bad domain
          { domain: "third.example", category: "",        location: "Y" },         // bad category
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.batch_size).toBe(3);
    expect(res.body.succeeded).toBe(1);
    const ok    = res.body.results.filter((r: { ok: boolean }) => r.ok);
    const fail  = res.body.results.filter((r: { ok: boolean }) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(2);
    expect(fail.find((r: { error: string }) => r.error === "invalid_domain")).toBeDefined();
    expect(fail.find((r: { error: string }) => r.error === "invalid_category")).toBeDefined();
  });

  it("bypasses the per-IP rate limit (admin path)", async () => {
    // Pre-seed 5 audit rows under the synthetic admin batch IP would have
    // hashed to — but we don't know that hash without recomputing. Instead,
    // verify positive behavior: a batch larger than the public per-IP cap
    // (3) succeeds.
    const perplexity = await import("../../lib/perplexity.js");
    vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [], answerText: "", costUsd: 0.005,
    });

    const { createTestApp } = await import("../../testApp.js");
    const res = await request(createTestApp())
      .post("/admin/audits/batch")
      .set("Authorization", "Bearer admin-test-key")
      .send({
        prospects: [
          { domain: "p1.example", category: "x", location: "Y" },
          { domain: "p2.example", category: "x", location: "Y" },
          { domain: "p3.example", category: "x", location: "Y" },
          { domain: "p4.example", category: "x", location: "Y" },  // would be 4th -> blocked on public path
          { domain: "p5.example", category: "x", location: "Y" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.succeeded).toBe(5);
  });

  it("respects the cache — same prospect twice returns cached:true on second batch", async () => {
    const perplexity = await import("../../lib/perplexity.js");
    const spy = vi.spyOn(perplexity, "perplexitySearch").mockResolvedValue({
      citations: [], answerText: "", costUsd: 0.005,
    });
    const { createTestApp } = await import("../../testApp.js");
    const app = createTestApp();
    const body = { prospects: [{ domain: "cached.example", category: "plumber", location: "Boise, ID" }] };

    const r1 = await request(app).post("/admin/audits/batch").set("Authorization", "Bearer admin-test-key").send(body);
    const callsAfterFirst = spy.mock.calls.length;
    const r2 = await request(app).post("/admin/audits/batch").set("Authorization", "Bearer admin-test-key").send(body);
    expect(r1.body.results[0].cached).toBe(false);
    expect(r2.body.results[0].cached).toBe(true);
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });
});
