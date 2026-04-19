/**
 * Tests for GET /agents/:slug/json-ld.json — public schema.org LocalBusiness
 * endpoint. Uses a real in-memory SQLite so the round-trip reflects the
 * column set that's actually in production, not a hand-maintained mock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";

describe("GET /agents/:slug/json-ld.json", () => {
  const tmp = path.join(os.tmpdir(), `json-ld-route-${Date.now()}.db`);
  let app: express.Express;

  beforeAll(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.API_KEY = "test-key";
    const { _resetDbForTests, getDb } = await import("../db.js");
    _resetDbForTests();
    const db = getDb();

    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location, website,
       phone, star_rating, review_count, pricing_tier, ratings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "acme", "Acme LLC", "Acme does things.", "[]", "k-acme", "plumber",
        "Boise, ID", "https://acme.example", "208-555-0100", 4.9, 180,
        "mid-range",
        JSON.stringify({ google: { rating: 4.9, count: 180 } }),
      );
    db.prepare(`INSERT INTO businesses
      (slug, name, description, services, api_key, category, location,
       star_rating, review_count)
      VALUES ('bare', 'Bare Biz', 'minimal', '[]', 'k-bare', 'plumber', 'Boise', 0, 0)`).run();

    const { agentRouter } = await import("./agent.js");
    app = express();
    app.use(express.json());
    app.use(agentRouter);
  });

  afterAll(async () => {
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.API_KEY;
  });

  it("404 on unknown slug", async () => {
    const res = await request(app).get("/agents/nonexistent/json-ld.json");
    expect(res.status).toBe(404);
  });

  it("returns application/ld+json with the schema.org shape", async () => {
    const res = await request(app).get("/agents/acme/json-ld.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/ld\+json/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["cache-control"]).toMatch(/max-age=3600/);

    const body = JSON.parse(res.text);
    expect(body["@context"]).toBe("https://schema.org");
    expect(body["@type"]).toBe("LocalBusiness");
    expect(body.name).toBe("Acme LLC");
    expect(body.description).toBe("Acme does things.");
    expect(body.url).toBe("https://acme.example");
    expect(body.telephone).toBe("208-555-0100");
    expect(body.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Boise",
      addressRegion: "ID",
    });
    expect(body.priceRange).toBe("$$");
    expect(body.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.9,
      reviewCount: 180,
      bestRating: 5,
      worstRating: 0,
    });
  });

  it("omits optional fields for a bare-minimum tenant", async () => {
    const res = await request(app).get("/agents/bare/json-ld.json");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.name).toBe("Bare Biz");
    expect(body.url).toBeUndefined();
    expect(body.telephone).toBeUndefined();
    expect(body.priceRange).toBeUndefined();
    // star_rating=0, review_count=0 is treated as valid data (not null),
    // so aggregateRating is emitted — but a SGE with 0 reviews won't win
    // anyway. If we want to gate on count>0 we can tighten later.
  });

  it("is publicly accessible without an API key", async () => {
    const res = await request(app).get("/agents/acme/json-ld.json");
    expect(res.status).toBe(200);
  });
});
