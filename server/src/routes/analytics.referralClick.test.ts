import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { analyticsRouter } from "./analytics.js";
import { insertAgentRequest } from "../repos/agentRequests.js";

describe("POST /analytics/:slug/referral-click", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key)
       VALUES ('acme','Acme','d','[]','friendly','k')`,
    ).run();
    _setDbForTesting(db);
    app = express();
    app.use(express.json());
    app.use(analyticsRouter);
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("persists agent_id and request_id when supplied", async () => {
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({
        destination: "https://x",
        ref: "ai",
        agent_id: "cursor",
        request_id: "rid-1",
      })
      .expect(200);
    const row = db
      .prepare("SELECT agent_id, request_id FROM click_events")
      .get() as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBe("cursor");
    expect(row.request_id).toBe("rid-1");
  });

  it("persists null agent_id and request_id for back-compat callers", async () => {
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({ destination: "https://x", ref: "ai" })
      .expect(200);
    const row = db
      .prepare("SELECT agent_id, request_id FROM click_events")
      .get() as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBeNull();
    expect(row.request_id).toBeNull();
  });

  it("backfills agent_requests.outcome_signal='click' when request_id matches a known row", async () => {
    const arId = insertAgentRequest(db, {
      agentId: "cursor",
      agentIdSource: "header",
      toolCalled: "query_business_agent",
      requestId: "rid-2",
      latencyMs: 1,
      costCents: 0,
    });
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({
        destination: "https://x",
        agent_id: "cursor",
        request_id: "rid-2",
      })
      .expect(200);
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests WHERE id = ?")
      .get(arId) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("click");
  });
});
