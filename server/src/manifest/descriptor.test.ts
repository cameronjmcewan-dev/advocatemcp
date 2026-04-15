import { describe, it, expect } from "vitest";
import { buildManifest, DESCRIPTORS, MANIFEST } from "./descriptor.js";
import { ManifestSchema } from "./schema.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryBusinessAgentInput, searchBusinessesInput, getAvailabilityInput, getQuoteInput, reserveSlotInput, initiateHandoffInput } from "./tools.js";
import { z } from "zod";
import {
  PER_IP_LIMIT_PER_MINUTE,
  PER_API_KEY_LIMIT_PER_HOUR,
} from "../middleware/rateLimit.js";

describe("descriptor registry", () => {
  it("lists exactly six tools today", () => {
    expect(DESCRIPTORS.map((d) => d.name).sort()).toEqual([
      "get_availability",
      "get_quote",
      "initiate_handoff",
      "query_business_agent",
      "reserve_slot",
      "search_businesses",
    ]);
  });

  it("each descriptor has non-empty description + static latency/cost", () => {
    for (const d of DESCRIPTORS) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.estimated_latency_ms).toBeGreaterThan(0);
      expect(d.estimated_cost_cents).toBeGreaterThanOrEqual(0);
      expect(typeof d.idempotent).toBe("boolean");
    }
  });
});

describe("buildManifest", () => {
  const m = buildManifest({ apiBase: "https://api.example.com", trackBase: "https://track.example.com" });

  it("produces a manifest that parses under ManifestSchema", () => {
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("includes all tools with JSON Schema input_schema", () => {
    expect(m.tools).toHaveLength(6);
    const names = m.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_availability", "get_quote", "initiate_handoff", "query_business_agent", "reserve_slot", "search_businesses"]);

    const qba = m.tools.find((t) => t.name === "query_business_agent")!;
    expect(qba.input_schema).toMatchObject({
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
      },
      required: ["slug", "query"],
    });

    const sb = m.tools.find((t) => t.name === "search_businesses")!;
    expect(sb.input_schema).toMatchObject({
      type: "object",
      required: ["search"],
    });
    // location is optional — must appear in properties but not in required
    expect((sb.input_schema as { properties: Record<string, unknown> }).properties.location).toBeDefined();
    expect((sb.input_schema as { required: string[] }).required).not.toContain("location");
  });

  it("agent_id is advocatemcp-central", () => {
    expect(m.agent_id).toBe("advocatemcp-central");
  });

  it("protocol_versions is an array", () => {
    expect(Array.isArray(m.protocol_versions)).toBe(true);
    expect(m.protocol_versions.length).toBeGreaterThan(0);
  });

  it("attribution_endpoint points at the worker /track path", () => {
    expect(m.attribution_endpoint).toBe("https://track.example.com/track");
  });
});

describe("MANIFEST cached const", () => {
  it("is a valid manifest", () => {
    expect(() => ManifestSchema.parse(MANIFEST)).not.toThrow();
  });

  it("is reference-stable across imports (built once at module load)", async () => {
    // Re-importing yields the same object reference (ESM module cache)
    const again = (await import("./descriptor.js")).MANIFEST;
    expect(again).toBe(MANIFEST);
  });
});

/**
 * Drift test: the set of tool names registered with McpServer must equal the
 * set of tool names in DESCRIPTORS. If they diverge, the manifest is lying
 * and agent clients will get either missing tools or 404s on claimed ones.
 */
describe("drift: MCP registry ↔ DESCRIPTORS", () => {
  it("every registered MCP tool appears in DESCRIPTORS and vice versa", async () => {
    // Build an isolated McpServer mirroring createMcpServer() without the
    // Express transport wiring. We tolerate some duplication here — this
    // test deliberately doesn't import createMcpServer() so a buggy mcp.ts
    // refactor can't silently "pass" by reading from the same broken source.
    const server = new McpServer({ name: "drift-check", version: "0.0.0" });
    server.tool(
      "query_business_agent",
      "drift probe",
      queryBusinessAgentInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "search_businesses",
      "drift probe",
      searchBusinessesInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "get_availability",
      "drift probe",
      getAvailabilityInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "get_quote",
      "drift probe",
      getQuoteInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "reserve_slot",
      "drift probe",
      reserveSlotInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    const initiateHandoffWrapper = z.object({
      slug: z.string().min(1),
      reservation_id: z.string().optional(),
      mode: z.enum(["human", "agent"]),
      payload: z.record(z.unknown()),
    });
    server.tool(
      "initiate_handoff",
      "drift probe",
      initiateHandoffWrapper.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );

    // The SDK stores registered tools at `server._registeredTools`. This is
    // the supported read path as of @modelcontextprotocol/sdk ^1.10 (see
    // node_modules/@modelcontextprotocol/sdk/server/mcp.d.ts).
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools
    ).sort();

    const descripted = DESCRIPTORS.map((d) => d.name).sort();

    expect(registered).toEqual(descripted);
  });

  it("createMcpServer's real registration matches DESCRIPTORS (prod path)", async () => {
    // Import the actual production factory and verify it registers every
    // descripted tool — not a parallel-universe server.
    const mcpModule = await import("../routes/mcp.js");
    // createMcpServer is currently not exported. If this test fails with a
    // missing-export, export it from mcp.ts (it's already exported-shaped,
    // and this test becomes the forcing function).
    const factory = (mcpModule as unknown as {
      createMcpServer?: (rid?: string) => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
    }).createMcpServer;
    expect(factory, "createMcpServer must be exported from routes/mcp.ts so the drift test can introspect it").toBeDefined();

    const s = factory!();
    const regKeys = Object.keys(
      (s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
    ).sort();
    expect(regKeys).toEqual(DESCRIPTORS.map((d) => d.name).sort());
  });
});

describe("rate_limits sourced from middleware constants", () => {
  it("per_ip_per_minute matches middleware PER_IP_LIMIT_PER_MINUTE", () => {
    expect(MANIFEST.rate_limits.per_ip_per_minute).toBe(
      PER_IP_LIMIT_PER_MINUTE
    );
  });

  it("per_agent_per_minute derives from PER_API_KEY_LIMIT_PER_HOUR / 60", () => {
    expect(MANIFEST.rate_limits.per_agent_per_minute).toBe(
      Math.floor(PER_API_KEY_LIMIT_PER_HOUR / 60)
    );
  });
});

describe("transports — explicit wiring", () => {
  it("lists http and sse with identical /mcp URL (Streamable HTTP covers both)", () => {
    const m = buildManifest({
      apiBase: "https://api.x",
      trackBase: "https://track.x",
    });
    expect(m.transports).toEqual([
      { kind: "http", url: "https://api.x/mcp" },
      { kind: "sse", url: "https://api.x/mcp" },
    ]);
  });

  it("MANIFEST.transports URLs use API_BASE_URL env var (or the default)", () => {
    const expected = process.env.API_BASE_URL ?? "https://api.advocatemcp.com";
    expect(MANIFEST.transports[0].url).toBe(`${expected}/mcp`);
    expect(MANIFEST.transports[1].url).toBe(`${expected}/mcp`);
  });
});
