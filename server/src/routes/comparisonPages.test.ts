/**
 * Path-reconstruction regression test for /compare/:host/*.
 *
 * The bug fixed in this test: the original handler prepended `/compare/`
 * to the wildcard tail, producing `/compare/compare/{a}-vs-{b}`. The DB
 * stores `/compare/{a}-vs-{b}` so every lookup missed. Production live
 * test on 2026-04-29 caught this end-to-end. This test asserts the
 * reconstructed path matches what the builder writes.
 */

import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import express from "express";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { comparisonPagesRouter } from "./comparisonPages.js";

describe("GET /compare/:host/* — path reconstruction", () => {
  const tmp = path.join(os.tmpdir(), `cmp-${Date.now()}.db`);

  beforeEach(async () => {
    process.env.DATABASE_PATH = tmp;
    process.env.FEATURE_COMPARISON_PAGES = "true";
    const { _resetDbForTests } = await import("../db.js");
    _resetDbForTests();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    const { getDb } = await import("../db.js");
    getDb();
  });

  afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(tmp + suffix, { force: true });
    delete process.env.DATABASE_PATH;
    delete process.env.FEATURE_COMPARISON_PAGES;
  });

  function makeApp(): express.Express {
    const app = express();
    app.use(comparisonPagesRouter);
    return app;
  }

  it("reconstructs path as /compare/{a}-vs-{b} (NOT /compare/compare/...)", async () => {
    const res = await request(makeApp()).get("/compare/advocatemcp.com/compare/foo-vs-bar");
    expect(res.status).toBe(404);
    // The 404 body echoes the path the route looked up. This is the
    // contract: it MUST be /compare/foo-vs-bar — not the doubled form.
    const body = JSON.parse(res.text) as { error: string; host: string; path: string };
    expect(body.error).toBe("not_found");
    expect(body.host).toBe("advocatemcp.com");
    expect(body.path).toBe("/compare/foo-vs-bar");
  });

  it("returns 200 + HTML when a matching live row exists", async () => {
    // Seed a minimal `comparison_pages` row to confirm the reconstructed
    // path actually matches stored rows. Schema columns match
    // migrations/035_comparison_pages.sql.
    const { getDb } = await import("../db.js");
    const db = getDb();
    // Need a competitors + businesses row to satisfy the FK chain.
    // businesses has many NOT NULL columns; pad them all with empty
    // strings so the test stays focused on path-reconstruction, not
    // on tracking schema drift in the legacy table.
    db.prepare(
      `INSERT INTO businesses (id, slug, name, api_key, description,
                category, location, services, referral_url, availability,
                created_at)
       VALUES (1, 'cust', 'Customer', 'k', '', '', '', '', '', '', ?)`,
    ).run(Date.now());
    db.exec(`INSERT INTO competitors (id, business_id, competitor_name, competitor_slug,
                  verified_facts_json, source_urls_json, facts_source, created_at, updated_at)
             VALUES (10, 1, 'Rival', 'rival', '{}', '[]', 'manual',
                  ${Date.now()}, ${Date.now()})`);
    db.prepare(
      `INSERT INTO comparison_pages (business_id, competitor_id, host, path, body_md,
                  schema_jsonld, fact_diff_json, generated_at, generator_version, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
    ).run(
      1, 10,
      "advocatemcp.com", "/compare/cust-vs-rival",
      "# Customer vs Rival\n\nCustomer reports A; Rival reports B. Sources: https://a.com",
      JSON.stringify({ "@type": "WebPage" }),
      JSON.stringify({ differentiators: [] }),
      Date.now(),
      "test-v1",
    );

    const res = await request(makeApp()).get("/compare/advocatemcp.com/compare/cust-vs-rival");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Customer vs Rival/);
  });
});
