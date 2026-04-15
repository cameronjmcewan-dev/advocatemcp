import { describe, it, expect } from "vitest";
import { buildManifest, DESCRIPTORS, MANIFEST } from "./descriptor.js";
import { ManifestSchema } from "./schema.js";

describe("descriptor registry", () => {
  it("lists exactly two tools today", () => {
    expect(DESCRIPTORS.map((d) => d.name).sort()).toEqual([
      "query_business_agent",
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

  it("includes both tools with JSON Schema input_schema", () => {
    expect(m.tools).toHaveLength(2);
    const names = m.tools.map((t) => t.name).sort();
    expect(names).toEqual(["query_business_agent", "search_businesses"]);

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
