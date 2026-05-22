/**
 * Regression test for the analytics route auth contract.
 *
 * The three `/analytics/:slug*` reads must accept BOTH:
 *   1. `Authorization: Bearer <slug.api_key>` — customer's direct API
 *      access path. Slug-bound.
 *   2. `X-API-Key: <SERVER_API_KEY>` — platform's worker-proxy path.
 *      The worker is the authorization boundary for dashboard requests
 *      (it runs `getUserBusinesses` before forwarding the call), so
 *      Railway can trust the global key when the request carries it.
 *
 * Why this file exists
 * --------------------
 * Worker PR #243 swapped `Bearer biz.api_key` → `X-API-Key env.API_KEY`
 * across all 18 worker→Railway call sites. That broke admin Tenants
 * page because `/analytics/:slug` was previously gated by
 * `requireSlugApiKey` (Bearer only) — `fetchAnalytics()` started
 * returning null for every row. Server-side fix is to switch these
 * three routes to `requireSlugOrAdminKey`. This test locks in the
 * new contract so a future "tighten security" pass can't silently
 * revert it without flipping six red tests.
 *
 * Each route gets two tests: Bearer-works + X-API-Key-works. The
 * supertest harness mirrors `analytics.referralClick.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { analyticsRouter } from "./analytics.js";

const TEST_BEARER  = "tenant-key-abc123";
const TEST_SERVER_KEY = "platform-server-key-xyz";

describe("/analytics/:slug auth contract — accepts Bearer OR X-API-Key", () => {
  let db: Database.Database;
  let app: express.Express;
  let originalServerKey: string | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key)
       VALUES ('acme','Acme','d','[]','friendly', ?)`,
    ).run(TEST_BEARER);
    _setDbForTesting(db);

    // The X-API-Key path checks against process.env.API_KEY at request
    // time (see requireServerKeyOnly + requireSlugOrAdminKey). Set it
    // for the duration of these tests and restore in afterEach.
    originalServerKey = process.env.API_KEY;
    process.env.API_KEY = TEST_SERVER_KEY;

    app = express();
    app.use(express.json());
    app.use(analyticsRouter);
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
    if (originalServerKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalServerKey;
    }
  });

  // ── /analytics/:slug ────────────────────────────────────────────────────

  it("GET /analytics/:slug returns 200 with Authorization: Bearer <slug.api_key>", async () => {
    const res = await request(app)
      .get("/analytics/acme")
      .set("Authorization", `Bearer ${TEST_BEARER}`);
    expect(res.status).toBe(200);
    // Sanity: payload shape didn't regress to a stub.
    expect(res.body).toHaveProperty("slug", "acme");
  });

  it("GET /analytics/:slug returns 200 with X-API-Key: <SERVER_API_KEY> (worker-proxy path)", async () => {
    const res = await request(app)
      .get("/analytics/acme")
      .set("X-API-Key", TEST_SERVER_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("slug", "acme");
  });

  // ── /analytics/:slug/clicks ─────────────────────────────────────────────

  it("GET /analytics/:slug/clicks returns 200 with Bearer", async () => {
    const res = await request(app)
      .get("/analytics/acme/clicks")
      .set("Authorization", `Bearer ${TEST_BEARER}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("slug", "acme");
    expect(res.body).toHaveProperty("clicks");
  });

  it("GET /analytics/:slug/clicks returns 200 with X-API-Key", async () => {
    const res = await request(app)
      .get("/analytics/acme/clicks")
      .set("X-API-Key", TEST_SERVER_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("slug", "acme");
  });

  // ── /analytics/:slug/activity ───────────────────────────────────────────

  it("GET /analytics/:slug/activity returns 200 with Bearer", async () => {
    const res = await request(app)
      .get("/analytics/acme/activity")
      .set("Authorization", `Bearer ${TEST_BEARER}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("slug", "acme");
  });

  it("GET /analytics/:slug/activity returns 200 with X-API-Key", async () => {
    const res = await request(app)
      .get("/analytics/acme/activity")
      .set("X-API-Key", TEST_SERVER_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("slug", "acme");
  });

  // ── Negative: no auth at all still 401 ──────────────────────────────────

  it("GET /analytics/:slug returns 401 when neither header is sent", async () => {
    const res = await request(app).get("/analytics/acme");
    expect(res.status).toBe(401);
  });

  it("GET /analytics/:slug returns 401 with a wrong Bearer for the slug", async () => {
    const res = await request(app)
      .get("/analytics/acme")
      .set("Authorization", "Bearer not-acmes-key");
    expect(res.status).toBe(401);
  });

  it("GET /analytics/:slug returns 401 with a wrong X-API-Key", async () => {
    const res = await request(app)
      .get("/analytics/acme")
      .set("X-API-Key", "not-the-platform-key");
    expect(res.status).toBe(401);
  });
});
