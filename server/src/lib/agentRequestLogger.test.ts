import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { _setDbForTesting } from "../db.js";
import { withAgentRequestLog } from "./agentRequestLogger.js";

function fakeReq(headers: Record<string, string> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as import("express").Request;
}

describe("withAgentRequestLog", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    _setDbForTesting(db);
  });
  afterEach(() => {
    _setDbForTesting(null);
    db.close();
  });

  it("writes one row when agent_id resolves from header", async () => {
    const req = fakeReq({ "x-agent-identity": "cursor" });
    const handler = vi.fn().mockResolvedValue({ ok: true });
    await withAgentRequestLog(
      {
        toolName: "query_business_agent",
        req,
        requestId: "rid-1",
        toolArgAgentId: undefined,
        businessSlug: "acme",
      },
      handler,
    );
    const rows = db
      .prepare(
        "SELECT agent_id, agent_id_source, tool_called, business_slug, request_id, outcome_signal FROM agent_requests",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: "cursor",
      agent_id_source: "header",
      tool_called: "query_business_agent",
      business_slug: "acme",
      request_id: "rid-1",
      outcome_signal: "none",
    });
  });

  it("writes a row with agent_id_source='tool_arg' when only arg is set", async () => {
    const req = fakeReq();
    await withAgentRequestLog(
      {
        toolName: "search_businesses",
        req,
        requestId: "rid-2",
        toolArgAgentId: "claude-desktop",
      },
      async () => ({ x: 1 }),
    );
    const row = db
      .prepare("SELECT agent_id_source FROM agent_requests")
      .get() as { agent_id_source: string };
    expect(row.agent_id_source).toBe("tool_arg");
  });

  it("skips logging when no agent_id is available (anonymous)", async () => {
    const req = fakeReq();
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const result = await withAgentRequestLog(
      {
        toolName: "search_businesses",
        req,
        requestId: "rid-3",
        toolArgAgentId: undefined,
      },
      handler,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
    const rows = db.prepare("SELECT id FROM agent_requests").all();
    expect(rows).toHaveLength(0);
  });

  it("records outcome_signal='error' and re-throws when handler throws", async () => {
    const req = fakeReq({ "x-agent-identity": "cursor" });
    await expect(
      withAgentRequestLog(
        {
          toolName: "get_quote",
          req,
          requestId: "rid-4",
          toolArgAgentId: undefined,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    const row = db
      .prepare("SELECT outcome_signal FROM agent_requests")
      .get() as { outcome_signal: string };
    expect(row.outcome_signal).toBe("error");
  });

  it("returns the inserted id so caller can later setOutcome", async () => {
    const req = fakeReq({ "x-agent-identity": "x" });
    let captured: string | null = null;
    await withAgentRequestLog(
      {
        toolName: "reserve_slot",
        req,
        requestId: "rid-5",
        toolArgAgentId: undefined,
        onLogged: (id) => {
          captured = id;
        },
      },
      async () => ({ reservation_id: "res_z" }),
    );
    expect(captured).toMatch(/^ar_/);
  });

  it("returns handler result even when success-path DB insert throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.exec("DROP TABLE agent_requests");
    const req = fakeReq({ "x-agent-identity": "cursor" });
    const result = await withAgentRequestLog(
      {
        toolName: "query_business_agent",
        req,
        requestId: "rid-rc3-a",
        toolArgAgentId: undefined,
        businessSlug: "the-bamboo-brace",
      },
      async () => ({ ok: true, payload: "claude response" }),
    );
    expect(result).toEqual({ ok: true, payload: "claude response" });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to write success-outcome row"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("rethrows original handler error when error-path DB insert also throws", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.exec("DROP TABLE agent_requests");
    const req = fakeReq({ "x-agent-identity": "cursor" });
    await expect(
      withAgentRequestLog(
        {
          toolName: "get_quote",
          req,
          requestId: "rid-rc3-b",
          toolArgAgentId: undefined,
        },
        async () => {
          throw new Error("handler boom");
        },
      ),
    ).rejects.toThrow("handler boom");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to write error-outcome row"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
