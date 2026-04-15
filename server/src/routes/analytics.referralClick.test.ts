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

  it("derives agent_id and request_id from queries row when not supplied on body (Session 11.5)", async () => {
    // Originating MCP call wrote a queries row with agent_id + request_id.
    // Worker today doesn't carry those values forward in the click-redirect
    // body — only query_id rides in the signed token. The handler must
    // hydrate from the queries row so click_events stamps the linkage.
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, intent, agent_id, request_id)
         VALUES ('acme', 'q', 'r', 'general', 'claude-desktop', 'rid-mcp-1')`,
      )
      .run();
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({
        destination: "https://x",
        ref: "claude-desktop",
        query_id: Number(lastInsertRowid),
      })
      .expect(200);
    const row = db
      .prepare("SELECT agent_id, request_id FROM click_events WHERE query_id = ?")
      .get(Number(lastInsertRowid)) as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBe("claude-desktop");
    expect(row.request_id).toBe("rid-mcp-1");
  });

  it("derived request_id still backfills agent_requests outcome to 'click' (Session 11.5)", async () => {
    const arId = insertAgentRequest(db, {
      agentId: "claude-desktop",
      agentIdSource: "header",
      toolCalled: "query_business_agent",
      requestId: "rid-mcp-2",
      latencyMs: 1,
      costCents: 0,
    });
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, intent, agent_id, request_id)
         VALUES ('acme', 'q', 'r', 'general', 'claude-desktop', 'rid-mcp-2')`,
      )
      .run();
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({
        destination: "https://x",
        query_id: Number(lastInsertRowid),
      })
      .expect(200);
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests WHERE id = ?")
      .get(arId) as { outcome_signal: string };
    expect(row.outcome_signal).toBe("click");
  });

  it("body-supplied agent_id wins over queries-row value (Session 11.5)", async () => {
    // If the worker eventually starts forwarding aid from the token, that
    // value should override the queries-row fallback — the worker is closer
    // to the actual click event.
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, intent, agent_id, request_id)
         VALUES ('acme', 'q', 'r', 'general', 'old-claude', 'rid-old')`,
      )
      .run();
    await request(app)
      .post("/analytics/acme/referral-click")
      .send({
        destination: "https://x",
        query_id: Number(lastInsertRowid),
        agent_id: "fresh-claude",
        request_id: "rid-fresh",
      })
      .expect(200);
    const row = db
      .prepare("SELECT agent_id, request_id FROM click_events WHERE query_id = ?")
      .get(Number(lastInsertRowid)) as { agent_id: string | null; request_id: string | null };
    expect(row.agent_id).toBe("fresh-claude");
    expect(row.request_id).toBe("rid-fresh");
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
