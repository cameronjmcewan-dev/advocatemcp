import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

describe("GET /api/competitor-radar/:slug/summary + /losses", () => {
  const tmp = path.join(os.tmpdir(), `p3-routes-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "admin-key";
    const { _resetDbForTests, getDb } = await import("../db.js");
    _resetDbForTests();
    const db = getDb();

    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "t1", "T1", "d", "[]", "tenant-key", "plumber", "Boise, ID",
        "https://tenant.com", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('t1', 'q', 'auto', 1, datetime('now'))`).run();

    const mkPoll = db.prepare(`INSERT INTO competitor_polls
      (slug, query_basket_id, bot, phrasing, phrasing_variant, polled_at, our_domain_cited, our_cited_rank, citation_count, cost_usd)
      VALUES ('t1', 1, 'perplexity', 'q', 0, ?, ?, ?, ?, 0.005)`);
    const mkCit = db.prepare(`INSERT INTO competitor_citations (poll_id, rank, url, domain, title) VALUES (?, ?, ?, ?, ?)`);

    // 20 cited polls (ranks 1-5), 10 lost, losses cite 3 distinct competitors.
    const now = new Date();
    for (let i = 0; i < 20; i++) {
      const rank = (i % 5) + 1;
      const info = mkPoll.run(new Date(now.getTime() - i * 1000).toISOString(), 1, rank, 5);
      mkCit.run(Number(info.lastInsertRowid), rank, "https://tenant.com", "tenant.com", "t");
    }
    const competitors = ["boiseplumbco.com", "aceplumbing.com", "plumbpro.com"];
    for (let i = 0; i < 10; i++) {
      const info = mkPoll.run(new Date(now.getTime() - (20 + i) * 1000).toISOString(), 0, null, 3);
      const pollId = Number(info.lastInsertRowid);
      mkCit.run(pollId, 1, `https://${competitors[i % 3]}/x`, competitors[i % 3]!, "c");
      mkCit.run(pollId, 2, `https://yelp.com/${i}`, "yelp.com", "y");
      mkCit.run(pollId, 3, `https://${competitors[(i + 1) % 3]}/y`, competitors[(i + 1) % 3]!, "c");
    }

    const { competitorRadarRouter } = await import("./competitorRadar.js");
    app = express();
    app.use(express.json());
    app.use(competitorRadarRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.API_KEY;
    delete process.env.DATABASE_PATH;
  });

  it("401 on summary without api key", async () => {
    const res = await request(app).get("/api/competitor-radar/t1/summary");
    expect(res.status).toBe(401);
  });

  it("returns summary shape for tenant with mixed polls", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/summary?days=30")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.total_polls).toBe(30);
    expect(res.body.cited_count).toBe(20);
    expect(res.body.citation_rate).toBeCloseTo(20 / 30, 3);
    expect(res.body.avg_cited_rank).toBeCloseTo(3, 3);
    expect(res.body.top_competitor_domains).toHaveLength(4); // 3 competitors + yelp
    expect(res.body.top_competitor_domains.find((d: { domain: string }) => d.domain === "tenant.com")).toBeUndefined();
    expect(res.body.last_polled_at).toBeDefined();
  });

  it("returns losses with top citations, limit-capped", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/losses?days=7&limit=5")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.losses.length).toBeLessThanOrEqual(5);
    expect(res.body.losses[0].top_citations.length).toBeGreaterThan(0);
    expect(res.body.losses[0].top_citations.length).toBeLessThanOrEqual(5);
  });

  it("caps losses limit at 200 even if caller asks for more", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/losses?days=7&limit=9999")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.losses.length).toBeLessThanOrEqual(200);
  });

  it("allows a slug-bound business key", async () => {
    const res = await request(app)
      .get("/api/competitor-radar/t1/summary?days=30")
      .set("Authorization", "Bearer tenant-key");
    expect(res.status).toBe(200);
    expect(res.body.total_polls).toBe(30);
  });

  it("rejects a business key used against a foreign slug", async () => {
    // Create a second tenant with a different key to prove isolation.
    const { getDb } = await import("../db.js");
    getDb().prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website, star_rating, review_count, plan)
      VALUES ('t2', 'T2', 'd', '[]', 'other-tenant-key', 'plumber', 'Boise', 'https://t2.com', 4.5, 10, 'pro')`).run();

    const res = await request(app)
      .get("/api/competitor-radar/t1/summary?days=30")
      .set("Authorization", "Bearer other-tenant-key");
    expect(res.status).toBe(401);
  });
});

describe("basket CRUD", () => {
  const tmp = path.join(os.tmpdir(), `p3-basket-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "admin-key";
    const { _resetDbForTests, getDb } = await import("../db.js");
    _resetDbForTests();
    const db = getDb();
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, star_rating, review_count, plan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pro')`).run(
        "tb", "TB", "d", "[]", "tenant-key", "plumber", "Boise, ID", 4.5, 10
      );
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'seeded auto', 'auto', 1, datetime('now'))`).run();
    db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'disabled old', 'tenant', 0, datetime('now'))`).run();

    const { competitorRadarRouter } = await import("./competitorRadar.js");
    app = express();
    app.use(express.json());
    app.use(competitorRadarRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.API_KEY;
    delete process.env.DATABASE_PATH;
  });

  it("GET returns only enabled queries", async () => {
    const res = await request(app)
      .get("/api/competitor-basket/tb")
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);
    expect(res.body.queries).toHaveLength(1);
    expect(res.body.queries[0].query).toBe("seeded auto");
  });

  it("POST creates a tenant-source query", async () => {
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "24/7 emergency plumber" });
    expect(res.status).toBe(201);
    expect(res.body.query).toBe("24/7 emergency plumber");
    expect(res.body.source).toBe("tenant");
  });

  it("POST rejects empty/long queries", async () => {
    const r1 = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "" });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "x".repeat(201) });
    expect(r2.status).toBe(400);
  });

  it("POST 409s on duplicate", async () => {
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "seeded auto" });
    expect(res.status).toBe(409);
  });

  it("POST 400s past 15-row cap", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', ?, 'tenant', 1, datetime('now'))`);
    for (let i = 0; i < 14; i++) stmt.run(`filler ${i}`);
    const res = await request(app)
      .post("/api/competitor-basket/tb/queries")
      .set("X-API-Key", "admin-key")
      .send({ query: "one too many" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cap/);
  });

  it("DELETE soft-deletes (enabled=0) a tenant row", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const info = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('tb', 'to-delete', 'tenant', 1, datetime('now'))`).run();
    const id = Number(info.lastInsertRowid);

    const res = await request(app)
      .delete(`/api/competitor-basket/tb/queries/${id}`)
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT enabled FROM competitor_query_baskets WHERE id=?")
      .get(id) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it("DELETE returns 404 for another tenant's id", async () => {
    const { getDb } = await import("../db.js");
    const db = getDb();
    const info = db.prepare(`INSERT INTO competitor_query_baskets (slug, query, source, enabled, created_at)
      VALUES ('other-tenant', 'cross', 'tenant', 1, datetime('now'))`).run();
    const id = Number(info.lastInsertRowid);

    const res = await request(app)
      .delete(`/api/competitor-basket/tb/queries/${id}`)
      .set("X-API-Key", "admin-key");
    expect(res.status).toBe(404);
  });
});
