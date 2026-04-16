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
    // Apps SDK compliance fields — surfaced so reviewers + agent frameworks
    // can discover privacy/terms/support without a second HTTP hop.
    expect(res.body).toHaveProperty(
      "support_contact",
      "mailto:support@advocatemcp.com",
    );
    expect(res.body).toHaveProperty(
      "privacy_url",
      "https://advocatemcp.com/privacy",
    );
    expect(res.body).toHaveProperty(
      "terms_url",
      "https://advocatemcp.com/terms",
    );
  });

  it("tools[].name includes all current MCP tools", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const names = (res.body.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["get_availability", "get_quote", "initiate_handoff", "query_business_agent", "reserve_slot", "search_businesses"]);
  });

  it("transports lists only http pointing at /mcp (SSE dropped — see descriptor.ts)", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const transports = res.body.transports as { kind: string; url: string }[];
    expect(transports.some((t) => t.kind === "http" && t.url.endsWith("/mcp"))).toBe(true);
    // SSE is no longer advertised: Cloudflare/Railway closes idle SSE channels
    // around 30s, and we never push server-initiated events. The /mcp GET
    // handler still serves SSE for backward-compat with Inspector-class clients
    // that default to SSE on connect — but discoverable manifests advertise
    // only HTTP so spec-compliant agents pick the working transport.
    expect(transports.some((t) => t.kind === "sse")).toBe(false);
  });
});
