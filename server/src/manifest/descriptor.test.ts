import { describe, it, expect } from "vitest";
import { buildManifest, DESCRIPTORS, MANIFEST } from "./descriptor.js";
import { ManifestSchema } from "./schema.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  queryBusinessAgentInput,
  searchBusinessesInput,
  getAvailabilityInput,
  getQuoteInput,
  reserveSlotInput,
  initiateHandoffInput,
  getCredentialsInput,
  getCancellationPolicyInput,
  requestCallbackInput,
  subscribeToUpdatesInput,
} from "./tools.js";
import { z } from "zod";
import {
  PER_IP_LIMIT_PER_MINUTE,
  PER_API_KEY_LIMIT_PER_HOUR,
} from "../middleware/rateLimit.js";

describe("descriptor registry", () => {
  it("lists exactly ten tools today", () => {
    // Apr 30 2026 — Phase 1 tool surface expansion added
    // get_credentials, get_cancellation_policy, request_callback,
    // subscribe_to_updates per the strategy-doc recommendation.
    expect(DESCRIPTORS.map((d) => d.name).sort()).toEqual([
      "get_availability",
      "get_cancellation_policy",
      "get_credentials",
      "get_quote",
      "initiate_handoff",
      "query_business_agent",
      "request_callback",
      "reserve_slot",
      "search_businesses",
      "subscribe_to_updates",
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

  it("each descriptor carries MCP tool annotations (title/readOnly/destructive/openWorld)", () => {
    for (const d of DESCRIPTORS) {
      // title is required by Anthropic's Connectors Directory submission —
      // missing it accounts for ~30% of directory rejections.
      expect(typeof d.annotations.title).toBe("string");
      expect(d.annotations.title.length).toBeGreaterThan(0);
      expect(typeof d.annotations.readOnlyHint).toBe("boolean");
      expect(typeof d.annotations.destructiveHint).toBe("boolean");
      expect(typeof d.annotations.openWorldHint).toBe("boolean");
    }
  });

  it("annotations match the Apps-SDK submission table", () => {
    const byName = Object.fromEntries(DESCRIPTORS.map((d) => [d.name, d.annotations]));
    expect(byName.query_business_agent).toEqual({
      title: "Query business agent",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.search_businesses).toEqual({
      title: "Search businesses",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get_availability).toEqual({
      title: "Get availability",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get_quote).toEqual({
      title: "Get quote",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.reserve_slot).toEqual({
      title: "Reserve slot",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.initiate_handoff).toEqual({
      title: "Initiate handoff",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.get_credentials).toEqual({
      title: "Get business credentials",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get_cancellation_policy).toEqual({
      title: "Get cancellation policy",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.request_callback).toEqual({
      title: "Request callback",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.subscribe_to_updates).toEqual({
      title: "Subscribe to updates",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });
});

describe("buildManifest", () => {
  const m = buildManifest({ apiBase: "https://api.example.com", trackBase: "https://track.example.com" });

  it("produces a manifest that parses under ManifestSchema", () => {
    expect(() => ManifestSchema.parse(m)).not.toThrow();
  });

  it("includes all tools with JSON Schema input_schema", () => {
    expect(m.tools).toHaveLength(10);
    const names = m.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_availability",
      "get_cancellation_policy",
      "get_credentials",
      "get_quote",
      "initiate_handoff",
      "query_business_agent",
      "request_callback",
      "reserve_slot",
      "search_businesses",
      "subscribe_to_updates",
    ]);

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

  it("surfaces annotations on every tool in the manifest output", () => {
    for (const t of m.tools) {
      const anno = (t as { annotations?: Record<string, unknown> }).annotations;
      expect(anno).toBeDefined();
      expect(typeof anno!.title).toBe("string");
      expect((anno!.title as string).length).toBeGreaterThan(0);
      expect(typeof anno!.readOnlyHint).toBe("boolean");
      expect(typeof anno!.destructiveHint).toBe("boolean");
      expect(typeof anno!.openWorldHint).toBe("boolean");
    }
  });

  it("exposes support_contact, privacy_url, and terms_url at the top level", () => {
    expect(m.support_contact).toBe("mailto:max@advocate-mcp.com");
    expect(m.privacy_url).toBe("https://advocatemcp.com/privacy");
    expect(m.terms_url).toBe("https://advocatemcp.com/terms");
  });
});

describe("MANIFEST — compliance top-level fields", () => {
  it("is published on the cached module-scoped MANIFEST (what /.well-known/mcp.json returns)", () => {
    expect(MANIFEST.support_contact).toBe("mailto:max@advocate-mcp.com");
    expect(MANIFEST.privacy_url).toBe("https://advocatemcp.com/privacy");
    expect(MANIFEST.terms_url).toBe("https://advocatemcp.com/terms");
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
    // Apr 30 2026 — Phase 1 tool surface expansion (4 new tools).
    server.tool(
      "get_credentials",
      "drift probe",
      getCredentialsInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "get_cancellation_policy",
      "drift probe",
      getCancellationPolicyInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "request_callback",
      "drift probe",
      requestCallbackInput.shape,
      async () => ({ content: [{ type: "text", text: "" }] })
    );
    server.tool(
      "subscribe_to_updates",
      "drift probe",
      subscribeToUpdatesInput.shape,
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

  it("every registered tool carries annotations matching DESCRIPTORS (tools/list surface)", async () => {
    const mcpModule = await import("../routes/mcp.js");
    const factory = (mcpModule as unknown as {
      createMcpServer?: (rid?: string) => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
    }).createMcpServer;
    const s = factory!();
    const registered = (s as unknown as {
      _registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
    })._registeredTools;
    for (const d of DESCRIPTORS) {
      const reg = registered[d.name];
      expect(reg, `tool ${d.name} is registered`).toBeDefined();
      expect(
        reg.annotations,
        `tool ${d.name} carries annotations on the MCP server`,
      ).toBeDefined();
      // title is the Anthropic Connectors Directory requirement that closes
      // the 30%-rejection gap; verify it propagates through annotationsFor()
      // into the actual tools/list response.
      expect(reg.annotations!.title).toBe(d.annotations.title);
      expect(reg.annotations!.readOnlyHint).toBe(d.annotations.readOnlyHint);
      expect(reg.annotations!.destructiveHint).toBe(d.annotations.destructiveHint);
      expect(reg.annotations!.openWorldHint).toBe(d.annotations.openWorldHint);
    }
  });
});

describe("query_business_agent input_schema includes Session 10 fields", () => {
  it("declares agent_id as optional string", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, { type?: string }> }).properties;
    expect(props.agent_id).toBeDefined();
    expect(props.agent_id.type).toBe("string");
  });

  it("declares stage as optional enum (browsing|comparing|committing)", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    const props = (tool!.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.stage).toBeDefined();
    expect(props.stage.enum).toEqual(["browsing", "comparing", "committing"]);
  });

  it("does not list agent_id or stage as required", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "query_business_agent");
    const required = ((tool!.input_schema as { required?: string[] }).required ?? []);
    expect(required).not.toContain("agent_id");
    expect(required).not.toContain("stage");
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

describe("rate_limits — Session 11 tiered shape", () => {
  it("MANIFEST.rate_limits exposes tiered per-agent-per-minute ceilings", () => {
    expect(MANIFEST.rate_limits.tiers).toEqual({
      unverified: 100,
      known: 250,
      trusted: 1000,
    });
  });
  it("retains the flat per_agent_per_minute key for back-compat clients", () => {
    expect(typeof MANIFEST.rate_limits.per_agent_per_minute).toBe("number");
  });
});

describe("transports — explicit wiring", () => {
  it("lists only http transport at /mcp (SSE dropped Apr 15 2026 — Cloudflare idles SSE channels)", () => {
    const m = buildManifest({
      apiBase: "https://api.x",
      trackBase: "https://track.x",
    });
    expect(m.transports).toEqual([
      { kind: "http", url: "https://api.x/mcp" },
    ]);
    // Defensive: assert SSE is not present so a future regression that
    // re-adds it is caught loudly. The /mcp GET route still serves SSE on
    // request for backward-compat — we just don't advertise it.
    expect(m.transports.find((t) => t.kind === "sse")).toBeUndefined();
  });

  it("MANIFEST.transports URL uses API_BASE_URL env var (or the localhost dev fallback)", () => {
    // Mirrors getApiBaseUrl(): env value if set, otherwise the dev/test fallback
    // localhost:3000. The "https://api.advocatemcp.com" placeholder used in the
    // pre-Apr-15 fallback is gone — see server/src/lib/baseUrl.ts.
    const expected = process.env.API_BASE_URL ?? "http://localhost:3000";
    expect(MANIFEST.transports[0].url).toBe(`${expected}/mcp`);
    expect(MANIFEST.transports.length).toBe(1);
  });
});
