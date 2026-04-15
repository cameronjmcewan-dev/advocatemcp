import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema, ManifestSchema } from "./schema.js";

describe("zodToJsonSchema — minimal converter", () => {
  it("converts z.string() to { type: 'string' }", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("preserves .describe() into description", () => {
    expect(zodToJsonSchema(z.string().describe("hello"))).toEqual({
      type: "string",
      description: "hello",
    });
  });

  it("preserves .min() as minLength", () => {
    expect(zodToJsonSchema(z.string().min(1))).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("marks optional strings via required[] omission on the parent object", () => {
    const out = zodToJsonSchema(
      z.object({ a: z.string(), b: z.string().optional() })
    );
    expect(out).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("handles nested describe + min together", () => {
    const out = zodToJsonSchema(
      z.object({
        slug: z.string().min(1).describe("The business slug"),
      })
    );
    expect(out).toEqual({
      type: "object",
      properties: {
        slug: { type: "string", minLength: 1, description: "The business slug" },
      },
      required: ["slug"],
      additionalProperties: false,
    });
  });

  it("throws on unsupported zod types", () => {
    expect(() => zodToJsonSchema(z.number())).toThrow(/unsupported zod type/i);
    expect(() => zodToJsonSchema(z.array(z.string()))).toThrow(/unsupported zod type/i);
  });
});

describe("ManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    const out = ManifestSchema.parse({
      spec_version: "2026-04-14",
      agent_id: "advocatemcp-central",
      protocol_versions: ["2025-03-26"],
      transports: [{ kind: "http", url: "https://api.advocatemcp.com/mcp" }],
      tools: [],
      rate_limits: { per_agent_per_minute: 100, per_ip_per_minute: 100 },
      auth_model: { modes: ["open"] },
      attribution_endpoint: "https://customers.advocatemcp.com/track",
    });
    expect(out.agent_id).toBe("advocatemcp-central");
  });

  it("rejects a manifest without protocol_versions", () => {
    expect(() =>
      ManifestSchema.parse({
        spec_version: "2026-04-14",
        agent_id: "x",
        transports: [],
        tools: [],
        rate_limits: { per_agent_per_minute: 1, per_ip_per_minute: 1 },
        auth_model: { modes: ["open"] },
        attribution_endpoint: "https://x",
      })
    ).toThrow();
  });
});
