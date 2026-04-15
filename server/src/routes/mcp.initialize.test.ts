import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";

describe("POST /mcp — initialize carries _meta.advocatemcp", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.DATABASE_PATH ??= ":memory:";
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();
  });

  it("initialize result includes _meta.advocatemcp manifest summary", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      });

    expect(res.status).toBe(200);
    // Streamable HTTP may reply as SSE; handle both body shapes.
    const text = res.text;
    const jsonMatch = text.match(/data:\s*({.+})/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : res.body;

    expect(parsed.result).toBeDefined();
    expect(parsed.result._meta).toBeDefined();
    expect(parsed.result._meta.advocatemcp).toBeDefined();
    const meta = parsed.result._meta.advocatemcp;
    expect(meta.agent_id).toBe("advocatemcp-central");
    expect(meta.manifest_url).toMatch(/\/\.well-known\/mcp\.json$/);
    expect(Array.isArray(meta.tools)).toBe(true);
    expect((meta.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "get_availability",
      "get_quote",
      "initiate_handoff",
      "query_business_agent",
      "reserve_slot",
      "search_businesses",
    ]);
  });
});
