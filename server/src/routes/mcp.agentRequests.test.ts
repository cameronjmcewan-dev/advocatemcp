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
  name: string,
  args: object,
  headers: Record<string, string> = {},
) {
  let req = request(app)
    .post("/mcp")
    .set("Content-Type", "application/json")
    .set("Accept", "application/json, text/event-stream");
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("MCP tool calls write agent_requests rows", () => {
  let db: Database.Database;
  let app: express.Express;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    db.prepare(
      `INSERT INTO businesses (slug, name, description, services, tone, api_key, website)
       VALUES ('acme', 'Acme', 'd', '["x"]', 'friendly', 'k', 'https://acme.example')`,
    ).run();
    app = makeApp(db);
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("query_business_agent with x-agent-identity writes one row", async () => {
    await callTool(
      app,
      "query_business_agent",
      { slug: "acme", query: "hi" },
      { "x-agent-identity": "cursor" },
    );
    const rows = db
      .prepare(
        "SELECT tool_called, agent_id, agent_id_source, business_slug FROM agent_requests",
      )
      .all();
    expect(rows).toEqual([
      {
        tool_called: "query_business_agent",
        agent_id: "cursor",
        agent_id_source: "header",
        business_slug: "acme",
      },
    ]);
  });

  it("search_businesses without identity writes nothing (anonymous)", async () => {
    await callTool(app, "search_businesses", { search: "acme" });
    const row = db
      .prepare("SELECT COUNT(*) c FROM agent_requests")
      .get() as { c: number };
    expect(row.c).toBe(0);
  });

  it("search_businesses with header writes a row with no business_slug", async () => {
    await callTool(
      app,
      "search_businesses",
      { search: "acme" },
      { "x-agent-identity": "cursor" },
    );
    const row = db
      .prepare(
        "SELECT tool_called, agent_id, agent_id_source, business_slug FROM agent_requests",
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      tool_called: "search_businesses",
      agent_id: "cursor",
      agent_id_source: "header",
      business_slug: null,
    });
  });

  it("get_availability with header writes a row tagged to slug", async () => {
    await callTool(
      app,
      "get_availability",
      { slug: "acme" },
      { "x-agent-identity": "cursor" },
    );
    const row = db
      .prepare(
        "SELECT tool_called, business_slug FROM agent_requests WHERE tool_called = 'get_availability'",
      )
      .get() as { tool_called: string; business_slug: string };
    expect(row).toEqual({
      tool_called: "get_availability",
      business_slug: "acme",
    });
  });

  it("reserve_slot stamps reservation_held + related_id on success", async () => {
    const now = Math.floor(Date.now() / 1000);
    await callTool(
      app,
      "reserve_slot",
      {
        slug: "acme",
        window_start: now + 3600,
        window_end: now + 5400,
        agent_id: "cursor",
        customer_contact: { name: "Test", contact: "test@example.com" },
        idempotency_key: "key-rs-1",
      },
      { "x-agent-identity": "cursor" },
    );
    const row = db
      .prepare(
        "SELECT outcome_signal, related_id, tool_called FROM agent_requests WHERE tool_called = 'reserve_slot'",
      )
      .get() as {
      outcome_signal: string;
      related_id: string | null;
      tool_called: string;
    };
    expect(row.outcome_signal).toBe("reservation_held");
    expect(row.related_id).toMatch(/^r_/);
  });
});
