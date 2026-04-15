import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { mcpRouter } from "./mcp.js";
import { requestIdMiddleware } from "../lib/requestId.js";

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "stub" }],
      }),
    };
  },
}));

function makeApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(mcpRouter);
  _setDbForTesting(db);
  return app;
}

function callTool(
  app: express.Express,
  body: object,
  headers: Record<string, string> = {},
) {
  let req = request(app)
    .post("/mcp")
    .set("Content-Type", "application/json")
    .set("Accept", "application/json, text/event-stream");
  for (const [k, v] of Object.entries(headers)) {
    req = req.set(k, v);
  }
  return req.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "query_business_agent", arguments: body },
  });
}

describe("mcp query_business_agent — Session 10 wiring", () => {
  let db: Database.Database;
  let app: express.Express;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key, website)
       VALUES ('acme', 'Acme Plumbing', 'desc', '["drain cleaning"]', 'friendly', 'x', 'https://acme.example.com')`,
    ).run();
    app = makeApp(db);
  });

  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("persists agent_id from x-agent-identity header (header > tool arg)", async () => {
    await callTool(
      app,
      { slug: "acme", query: "tell me about acme", agent_id: "cursor", stage: "browsing" },
      { "x-agent-identity": "claude-desktop" },
    );
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as {
      agent_id: string | null;
      stage: string;
    };
    expect(row.agent_id).toBe("claude-desktop"); // header wins
    expect(row.stage).toBe("browsing");
  });

  it("falls back to tool arg when no header", async () => {
    await callTool(app, {
      slug: "acme",
      query: "compare to others",
      agent_id: "cursor",
      stage: "comparing",
    });
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as {
      agent_id: string | null;
      stage: string;
    };
    expect(row.agent_id).toBe("cursor");
    expect(row.stage).toBe("comparing");
  });

  it("persists null agent_id and null stage when neither supplied (back-compat)", async () => {
    await callTool(app, { slug: "acme", query: "hello" });
    const row = db.prepare("SELECT agent_id, stage FROM queries").get() as {
      agent_id: string | null;
      stage: string | null;
    };
    expect(row.agent_id).toBeNull();
    expect(row.stage).toBeNull();
  });
});
