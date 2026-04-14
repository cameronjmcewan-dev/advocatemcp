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
});
