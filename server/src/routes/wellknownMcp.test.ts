import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";

describe("GET /.well-known/mcp.json", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.DATABASE_PATH ??= ":memory:";
    const { createTestApp } = await import("../testApp.js");
    app = createTestApp();
  });

  it("returns 200 with application/json content type", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns a cache-friendly response", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
  });

  it("includes all top-level manifest fields", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    expect(res.body).toHaveProperty("spec_version");
    expect(res.body).toHaveProperty("agent_id", "advocatemcp-central");
    expect(Array.isArray(res.body.protocol_versions)).toBe(true);
    expect(Array.isArray(res.body.transports)).toBe(true);
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body).toHaveProperty("rate_limits");
    expect(res.body).toHaveProperty("auth_model");
    expect(res.body).toHaveProperty("attribution_endpoint");
  });

  it("tools[].name includes all current MCP tools", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const names = (res.body.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["get_availability", "query_business_agent", "search_businesses"]);
  });

  it("transports lists both http and sse pointing at /mcp", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const transports = res.body.transports as { kind: string; url: string }[];
    expect(transports.some((t) => t.kind === "http" && t.url.endsWith("/mcp"))).toBe(true);
    expect(transports.some((t) => t.kind === "sse" && t.url.endsWith("/mcp"))).toBe(true);
  });
});
