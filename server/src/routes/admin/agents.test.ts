import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../db/migrations.js";
import { _setDbForTesting } from "../../db.js";
import { upsertReputation } from "../../repos/agentReputation.js";
import { adminRouter } from "./index.js";

describe("GET /admin/agents", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
    process.env.ADMIN_API_KEY = "test-admin";
    app = express();
    app.use(express.json());
    app.use(adminRouter);
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
    delete process.env.ADMIN_API_KEY;
  });

  it("401s without bearer token", async () => {
    const r = await request(app).get("/admin/agents");
    expect(r.status).toBe(401);
  });
  it("401s with wrong bearer token", async () => {
    const r = await request(app).get("/admin/agents").set("Authorization", "Bearer wrong");
    expect(r.status).toBe(401);
  });
  it("returns the reputation rollup as JSON when authed", async () => {
    upsertReputation(db, {
      agent_id: "x",
      window: "7d",
      requests: 10,
      reservations_confirmed: 1,
      conversion_rate: 0.1,
      avg_cost_cents: 0,
      quality_score: 0.5,
    });
    const r = await request(app)
      .get("/admin/agents")
      .set("Authorization", "Bearer test-admin");
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([
      expect.objectContaining({
        agent_id: "x",
        window: "7d",
        requests: 10,
        quality_score: 0.5,
      }),
    ]);
  });
});
