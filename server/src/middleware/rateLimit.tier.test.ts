import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { upsertReputation } from "../repos/agentReputation.js";
import { rateLimitMiddleware, _resetRateLimitBuckets } from "./rateLimit.js";

function makeApp() {
  const app = express();
  app.use(rateLimitMiddleware);
  app.get("/x", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("rateLimitMiddleware tier-aware ceilings", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    _resetRateLimitBuckets();
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("allows 150 req/min for known tier (past unverified's 100 ceiling)", async () => {
    upsertReputation(db, {
      agent_id: "k",
      window: "7d",
      requests: 50,
      reservations_confirmed: 5,
      conversion_rate: 0.1,
      avg_cost_cents: 0,
      quality_score: 0.5,
    });
    const app = makeApp();
    for (let i = 0; i < 150; i++) {
      const r = await request(app).get("/x").set("x-agent-identity", "k");
      expect(r.status).toBe(200);
    }
  });

  it("returns 429 to unverified at the 101st request in a minute", async () => {
    const app = makeApp();
    let lastStatus = 0;
    for (let i = 0; i < 101; i++) {
      const r = await request(app).get("/x");
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });

  it("trusted tier (1000/min) survives 300 requests", async () => {
    upsertReputation(db, {
      agent_id: "t",
      window: "7d",
      requests: 200,
      reservations_confirmed: 100,
      conversion_rate: 0.5,
      avg_cost_cents: 0,
      quality_score: 1.0,
    });
    const app = makeApp();
    for (let i = 0; i < 300; i++) {
      const r = await request(app).get("/x").set("x-agent-identity", "t");
      expect(r.status).toBe(200);
    }
  });
});
