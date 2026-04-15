import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema, ManifestSchema } from "./schema.js";
import { queryBusinessAgentInput, searchBusinessesInput } from "./tools.js";

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

  it("converts z.number() to { type: 'number' }", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("throws on unsupported zod types", () => {
    expect(() => zodToJsonSchema(z.array(z.string()))).toThrow(/unsupported zod type/i);
    expect(() => zodToJsonSchema(z.boolean())).toThrow(/unsupported zod type/i);
  });

  it("converts z.enum([...]) to { type: 'string', enum: [...] }", () => {
    expect(zodToJsonSchema(z.enum(["a", "b", "c"]))).toEqual({
      type: "string",
      enum: ["a", "b", "c"],
    });
  });

  it("preserves description on z.enum", () => {
    const out = zodToJsonSchema(z.enum(["x", "y"]).describe("pick one"));
    expect(out).toEqual({
      type: "string",
      enum: ["x", "y"],
      description: "pick one",
    });
  });

  it("converts z.record(z.string()) to object with additionalProperties", () => {
    const out = zodToJsonSchema(z.record(z.string()));
    expect(out).toEqual({ type: "object", additionalProperties: { type: "string" } });
  });

  it("converts ZodLiteral to { const }", () => {
    const out = zodToJsonSchema(z.literal("human"));
    expect(out).toEqual({ const: "human" });
  });

  it("converts ZodDiscriminatedUnion to oneOf", () => {
    const u = z.discriminatedUnion("k", [
      z.object({ k: z.literal("a"), a: z.string() }),
      z.object({ k: z.literal("b"), b: z.string() }),
    ]);
    const out = zodToJsonSchema(u);
    expect(out).toHaveProperty("oneOf");
    expect((out as { oneOf: unknown[] }).oneOf).toHaveLength(2);
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

describe("shared tool input shapes", () => {
  it("queryBusinessAgentInput validates slug + query", () => {
    expect(() =>
      queryBusinessAgentInput.parse({ slug: "joes-pizza", query: "hours?" })
    ).not.toThrow();
    expect(() => queryBusinessAgentInput.parse({ slug: "", query: "x" })).toThrow();
    expect(() => queryBusinessAgentInput.parse({ slug: "x" })).toThrow();
  });

  it("searchBusinessesInput makes location optional", () => {
    expect(() => searchBusinessesInput.parse({ search: "pizza" })).not.toThrow();
    expect(() =>
      searchBusinessesInput.parse({ search: "pizza", location: "Austin" })
    ).not.toThrow();
    expect(() => searchBusinessesInput.parse({ search: "" })).toThrow();
  });
});
