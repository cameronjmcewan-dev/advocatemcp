# Session 8 — A2A-native discovery manifest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task ends with a test-fail → implement → test-pass → commit rhythm.

**Goal:** Zero-human-integration discovery. An agent framework that fetches `GET /.well-known/mcp.json` (or opens an MCP `initialize` session) learns every tool, input schema, transport, rate limit, auth mode, and attribution endpoint without any custom config.

**Architecture:**

- **Typed descriptor** at `server/src/manifest/descriptor.ts` is the one list of tools. It re-exports the zod input schemas that `server/src/routes/mcp.ts` consumes when calling `server.tool(...)`. This is the **decision on Hard Question 1**: tool schemas live in `server/src/manifest/tools.ts`, imported both by the MCP server and by `buildManifest()`. The registry is the single source of truth; MCP tool registration and the manifest can never drift because both read the same symbols.
- **Manifest builder** `buildManifest(opts): Manifest` in `server/src/manifest/descriptor.ts` composes the JSON blob at module load time (once, cached in a module-level `const MANIFEST = buildManifest({...})`). This is the **decision on Hard Question 3**: build-at-boot. The route handler and the `initialize._meta` hook both read the pre-computed constant. Rate-limit numbers are sourced from `server/src/middleware/rateLimit.ts` constants (**Hard Question 4-adjacent**); `estimated_latency_ms` / `estimated_cost_cents` are per-tool static numbers declared inline in the descriptor (**Hard Question 4 decision: static v1**; justified because they're advisory hints for clients, not SLOs — a runtime-measured version is a future concern).
- **zod → JSON Schema** converter: a hand-rolled minimal converter at `server/src/manifest/schema.ts` covering `z.string()`, `z.string().min()`, `z.string().optional()`, `z.string().describe()`, and `z.object({...})`. This is the **decision on Hard Question 2**: hand-roll. Rationale: our two tools have 4 total fields, all strings; the `zod-to-json-schema` package is a new dep, and CLAUDE.md forbids unapproved deps. If Session 9 adds tools with richer input shapes (numbers, arrays, enums, unions) we'll reassess then — but in that session, not this one. The converter throws on unsupported zod nodes so we fail loud if it ever sees something it doesn't cover.
- **Well-known route** `server/src/routes/wellknownMcp.ts` serves `GET /.well-known/mcp.json` with `Content-Type: application/json` and `Cache-Control: public, max-age=300`. Registered in `server/src/testApp.ts` alongside the existing `wellknownRouter`.
- **`initialize._meta` embedding** extends the existing per-request `McpServer` in `server/src/routes/mcp.ts` by wiring an `initialize` request handler that spreads the manifest's capabilities into `_meta.advocatemcp`. Safe for clients that ignore `_meta`.
- **Drift test** `server/src/manifest/descriptor.test.ts` asserts every name in `DESCRIPTORS[].name` appears in the real `McpServer` tool list, and vice versa, by booting a `McpServer` instance and reading `server._registeredTools` (the SDK exposes this via its `listTools` handler).
- **Worker tenant mirror** extends `buildWellKnownResponse()` in `worker/src/index.ts` (lines 133–168) to add two new fields: `agent_id: slug` (when known) and `manifest_url: ${apiBase}/.well-known/mcp.json`. Back-compat: all existing fields stay. The worker does not fetch the manifest; it links to it.

**Tech Stack:** Node 20, TypeScript strict, Express 4, `@modelcontextprotocol/sdk` ^1.10, zod ^3.23, vitest 4, supertest 7. No new deps. Worker side: Cloudflare Workers runtime, `wrangler dev` for manual verification.

**Baseline at plan time:** server test suite must be green on `main` before Task 1. Run `cd server && npx vitest run` and confirm all pass. Worker test suite must also be green: `cd worker && npm test`. Every task below must leave both suites green.

**Branch:** `feature/session-8-a2a-manifest` (already in `.worktrees/session-8-manifest/`).

---

## File Structure

| File | Role | Action |
|---|---|---|
| `server/src/manifest/schema.ts` | zod manifest schema + `zodToJsonSchema()` converter | Create |
| `server/src/manifest/schema.test.ts` | Tests: converter covers every shape, throws on unsupported | Create |
| `server/src/manifest/tools.ts` | Shared zod input shapes for `query_business_agent` + `search_businesses` | Create |
| `server/src/manifest/descriptor.ts` | Typed tool descriptors + `buildManifest()` + cached `MANIFEST` const | Create |
| `server/src/manifest/descriptor.test.ts` | Drift test: MCP registry ↔ DESCRIPTORS parity | Create |
| `server/src/routes/wellknownMcp.ts` | `GET /.well-known/mcp.json` route | Create |
| `server/src/routes/wellknownMcp.test.ts` | Route integration test | Create |
| `server/src/routes/mcp.ts` | Import zod shapes from `manifest/tools.ts`; add `initialize._meta` | Modify |
| `server/src/routes/mcp.initialize.test.ts` | Tests `_meta.advocatemcp` appears in initialize result | Create |
| `server/src/testApp.ts` | Register `wellknownMcpRouter` | Modify |
| `server/src/middleware/rateLimit.ts` | Export limit constants for manifest to read | Modify |
| `worker/src/index.ts` | Extend `buildWellKnownResponse()` with `agent_id` + `manifest_url` | Modify |
| `worker/test/wellknown.test.ts` | Assert worker mirror has `agent_id` + `manifest_url` | Create if absent |
| `AGENTS.md` | New top-level doc describing the manifest + discovery flow | Create |

---

## Task sequence and dependencies

```
Task 1 (schema.ts — zod schema + converter)
      ↓
Task 2 (tools.ts — extract shared zod input shapes)
      ↓
Task 3 (descriptor.ts — DESCRIPTORS + buildManifest + MANIFEST const)
      ↓
Task 4 (wellknownMcp.ts route + register in testApp)
      ↓
Task 5 (mcp.ts — import from manifest/tools.ts; add initialize._meta)
      ↓
Task 6 (drift test in descriptor.test.ts)
      ↓
Task 7 (rate-limit constants wiring — export + consume)
      ↓
Task 8 (transports wiring — both POST and GET /mcp listed correctly)
      ↓
Task 9 (worker tenant mirror — agent_id + manifest_url)
      ↓
Task 10 (AGENTS.md)
```

Recommended execution: strict linear order 1 → 10. Task 6 technically depends on Task 5, which depends on Task 2. The drift test is deliberately last-in-the-server-block so any refactor in Tasks 2–5 can't accidentally fake passing it.

---

## Task 1: zod manifest schema + hand-rolled `zodToJsonSchema`

**Files:**
- Create: `server/src/manifest/schema.ts`
- Create: `server/src/manifest/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/manifest/schema.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test, confirm it fails**

```
cd server && npx vitest run src/manifest/schema.test.ts
```

Expected output: `Cannot find module './schema.js'` — the module doesn't exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `server/src/manifest/schema.ts`:

```typescript
import { z, ZodTypeAny } from "zod";

/**
 * Minimal zod → JSON Schema converter.
 *
 * Covers exactly the shapes used by AdvocateMCP tool inputs today:
 *   - z.string()
 *   - z.string().min(n)
 *   - z.string().optional()
 *   - z.string().describe(txt)
 *   - z.object({ ... })
 *
 * Throws on anything else so a silent drift (e.g. Session 9 adds a number
 * field and the manifest quietly omits it) becomes a loud test failure.
 *
 * Rationale over `zod-to-json-schema` npm dep: we have 4 fields in 2 tools.
 * The dep is ~20kb and forbidden-without-approval per CLAUDE.md. Reassess
 * when Session 9 introduces tools with numbers/arrays/enums/unions.
 */
export type JsonSchemaNode =
  | { type: "string"; description?: string; minLength?: number }
  | {
      type: "object";
      properties: Record<string, JsonSchemaNode>;
      required: string[];
      additionalProperties: false;
    };

export function zodToJsonSchema(node: ZodTypeAny): JsonSchemaNode {
  const def = node._def as {
    typeName: string;
    description?: string;
    checks?: Array<{ kind: string; value?: number }>;
    innerType?: ZodTypeAny;
    shape?: () => Record<string, ZodTypeAny>;
  };

  // Unwrap ZodOptional by recursing into innerType — optionality is a
  // property of the parent object's `required[]`, not the field itself.
  if (def.typeName === "ZodOptional" && def.innerType) {
    return zodToJsonSchema(def.innerType);
  }

  if (def.typeName === "ZodString") {
    const out: JsonSchemaNode = { type: "string" };
    if (def.description) out.description = def.description;
    for (const check of def.checks ?? []) {
      if (check.kind === "min" && typeof check.value === "number") {
        out.minLength = check.value;
      }
    }
    return out;
  }

  if (def.typeName === "ZodObject" && def.shape) {
    const shape = def.shape();
    const properties: Record<string, JsonSchemaNode> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(child);
      const childDef = child._def as { typeName: string };
      if (childDef.typeName !== "ZodOptional") required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }

  throw new Error(
    `zodToJsonSchema: unsupported zod type "${def.typeName}". ` +
      `Session 8 converter covers string + object + optional only. ` +
      `Add support in server/src/manifest/schema.ts if a new tool needs it.`
  );
}

/**
 * zod schema that validates the full manifest shape. Importing code should
 * `.parse()` the output of `buildManifest()` at module load as a belt-and-
 * suspenders check — a malformed manifest fails fast at boot, not in prod.
 */
export const ManifestSchema = z.object({
  spec_version: z.string(),
  agent_id: z.string(),
  protocol_versions: z.array(z.string()).min(1),
  transports: z.array(
    z.object({
      kind: z.enum(["http", "sse"]),
      url: z.string().url(),
    })
  ),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      input_schema: z.unknown(),
      output_schema: z.unknown(),
      idempotent: z.boolean(),
      estimated_latency_ms: z.number().int().positive(),
      estimated_cost_cents: z.number().nonnegative(),
    })
  ),
  rate_limits: z.object({
    per_agent_per_minute: z.number().int().positive(),
    per_ip_per_minute: z.number().int().positive(),
  }),
  auth_model: z.object({
    modes: z.array(
      z.enum(["open", "api_key", "oauth2.1_client_credentials_preview"])
    ),
  }),
  attribution_endpoint: z.string().url(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
```

- [ ] **Step 4: Run the test, confirm it passes**

```
cd server && npx vitest run src/manifest/schema.test.ts
```

Expected: all 8 test cases pass.

- [ ] **Step 5: Commit**

```
git add server/src/manifest/schema.ts server/src/manifest/schema.test.ts
git commit -m "feat(manifest): zod manifest schema + minimal zod→JSON Schema converter"
```

---

## Task 2: Extract shared tool input shapes into `manifest/tools.ts`

**Files:**
- Create: `server/src/manifest/tools.ts`
- Modify: `server/src/routes/mcp.ts` (import the shapes instead of redeclaring)

Goal: make the zod input shapes a shared symbol so the MCP server and the manifest descriptor can both import them. No behavior change.

- [ ] **Step 1: Write the failing test**

Extend `server/src/manifest/schema.test.ts` by appending:

```typescript
import { queryBusinessAgentInput, searchBusinessesInput } from "./tools.js";

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
```

Run:

```
cd server && npx vitest run src/manifest/schema.test.ts
```

Expected: `Cannot find module './tools.js'`.

- [ ] **Step 2: Write the implementation**

Create `server/src/manifest/tools.ts`:

```typescript
import { z } from "zod";

/**
 * Shared zod input shapes for MCP tools.
 *
 * Single source of truth: `server/src/routes/mcp.ts` imports these when
 * registering tools with `server.tool(...)`; `server/src/manifest/descriptor.ts`
 * imports them to build the A2A manifest's `input_schema`. Changing a tool's
 * input is one edit here and both surfaces update automatically.
 */

export const queryBusinessAgentInput = z.object({
  slug: z
    .string()
    .min(1)
    .describe(
      "The business slug identifier (e.g. 'joes-pizza-austin'). " +
        "Use search_businesses first if you don't know the slug."
    ),
  query: z
    .string()
    .min(1)
    .describe("The user's question about this business"),
});

export const searchBusinessesInput = z.object({
  search: z
    .string()
    .min(1)
    .describe(
      "Search term — matched against business name, description, and services"
    ),
  location: z
    .string()
    .optional()
    .describe(
      "Optional location filter (city, state, or region). Narrows results geographically."
    ),
});

export type QueryBusinessAgentInput = z.infer<typeof queryBusinessAgentInput>;
export type SearchBusinessesInput = z.infer<typeof searchBusinessesInput>;
```

Now modify `server/src/routes/mcp.ts` to import from this module instead of declaring the shapes inline. Replace lines 31–43 (the inline object schema passed to `server.tool("query_business_agent", ...)`) with a reference to `queryBusinessAgentInput.shape`, and similarly for `search_businesses` at lines 94–106.

Concretely, change the imports at the top:

```typescript
import { getDb, type BusinessRow } from "../db.js";
import { queryAgent } from "../agent/query.js";
import {
  queryBusinessAgentInput,
  searchBusinessesInput,
} from "../manifest/tools.js";
```

(Drop the `import { z } from "zod";` line — no longer needed in this file.)

Change the first `server.tool(...)` call. Before:

```typescript
  server.tool(
    "query_business_agent",
    "Query a registered business's AI advocate agent. " +
      "Use this when a user asks about a specific local business or service provider. " +
      "Returns a concise, citation-ready answer from the business's dedicated AI agent.",
    {
      slug: z
        .string()
        .min(1)
        .describe(
          "The business slug identifier (e.g. 'joes-pizza-austin'). " +
            "Use search_businesses first if you don't know the slug."
        ),
      query: z
        .string()
        .min(1)
        .describe("The user's question about this business"),
    },
    async ({ slug, query }) => {
```

After:

```typescript
  server.tool(
    "query_business_agent",
    "Query a registered business's AI advocate agent. " +
      "Use this when a user asks about a specific local business or service provider. " +
      "Returns a concise, citation-ready answer from the business's dedicated AI agent.",
    queryBusinessAgentInput.shape,
    async ({ slug, query }) => {
```

Do the same for `search_businesses`: replace the inline object literal (lines 94–106) with `searchBusinessesInput.shape`.

- [ ] **Step 3: Run all affected tests**

```
cd server && npx vitest run
```

Expected: every test in the server suite passes, including the newly added `queryBusinessAgentInput` / `searchBusinessesInput` tests and all pre-existing MCP tests.

- [ ] **Step 4: Commit**

```
git add server/src/manifest/tools.ts server/src/manifest/schema.test.ts server/src/routes/mcp.ts
git commit -m "refactor(mcp): extract tool input shapes into shared manifest/tools module"
```

---

## Task 3: Descriptor registry + `buildManifest()` + cached `MANIFEST` const

**Files:**
- Create: `server/src/manifest/descriptor.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/manifest/descriptor.test.ts`:

```typescript
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

  it("is reference-stable across imports (built once at module load)", () => {
    // Importing twice yields the same object reference
    const again = require("./descriptor.js").MANIFEST;
    expect(again).toBe(MANIFEST);
  });
});
```

Run:

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: module-not-found.

- [ ] **Step 2: Write the implementation**

Create `server/src/manifest/descriptor.ts`:

```typescript
import {
  queryBusinessAgentInput,
  searchBusinessesInput,
} from "./tools.js";
import {
  zodToJsonSchema,
  ManifestSchema,
  type JsonSchemaNode,
  type Manifest,
} from "./schema.js";

/**
 * Typed descriptor for a single tool. This is the registry row; the MCP
 * server and the A2A manifest both read from the same list.
 *
 * `estimated_latency_ms` and `estimated_cost_cents` are advisory static
 * numbers for v1 — they guide clients' scheduling/budgeting decisions but
 * are not SLOs. A runtime-measured version is Session 11+ work.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputZod: typeof queryBusinessAgentInput | typeof searchBusinessesInput;
  outputSchema: JsonSchemaNode;
  idempotent: boolean;
  estimated_latency_ms: number;
  estimated_cost_cents: number;
}

export const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "query_business_agent",
    description:
      "Query a registered business's AI advocate agent. " +
      "Use this when a user asks about a specific local business or service provider. " +
      "Returns a concise, citation-ready answer from the business's dedicated AI agent.",
    inputZod: queryBusinessAgentInput,
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "Citation-ready answer text" },
        referral_url: {
          type: "string",
          description: "Tracked URL to the business's site",
        },
      },
      required: ["answer"],
      additionalProperties: false,
    },
    idempotent: false, // each call logs to queries table + consumes Claude tokens
    estimated_latency_ms: 1500,
    estimated_cost_cents: 2,
  },
  {
    name: "search_businesses",
    description:
      "Search for registered businesses by category, name, or location. " +
      "Returns a list of matching businesses with their slugs and agent endpoints. " +
      "Use this to discover which businesses are available before querying one.",
    inputZod: searchBusinessesInput,
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "string",
          description: "JSON-encoded array of business records",
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    idempotent: true, // read-only SQL over businesses table
    estimated_latency_ms: 50,
    estimated_cost_cents: 0,
  },
];

export interface BuildManifestOptions {
  apiBase: string; // e.g. https://api.advocatemcp.com
  trackBase: string; // e.g. https://customers.advocatemcp.com
}

export function buildManifest(opts: BuildManifestOptions): Manifest {
  const m: Manifest = {
    spec_version: "2026-04-14",
    agent_id: "advocatemcp-central",
    protocol_versions: ["2025-03-26"], // current MCP spec version; array per Session 8 risk callout
    transports: [
      { kind: "http", url: `${opts.apiBase}/mcp` },
      { kind: "sse", url: `${opts.apiBase}/mcp` },
    ],
    tools: DESCRIPTORS.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: zodToJsonSchema(d.inputZod),
      output_schema: d.outputSchema,
      idempotent: d.idempotent,
      estimated_latency_ms: d.estimated_latency_ms,
      estimated_cost_cents: d.estimated_cost_cents,
    })),
    rate_limits: {
      per_agent_per_minute: 0, // filled in Task 7
      per_ip_per_minute: 0,    // filled in Task 7
    },
    auth_model: {
      modes: ["open", "api_key"],
    },
    attribution_endpoint: `${opts.trackBase}/track`,
  };
  // Belt-and-suspenders: throw loudly at module load if the manifest is malformed.
  // Will be re-parsed with real rate limits in Task 7.
  return m;
}

/**
 * Cached, module-scoped manifest built once at boot from env. The well-known
 * route and the MCP `initialize` hook both read this constant — the handler
 * never rebuilds per-request.
 */
const API_BASE = process.env.API_BASE_URL ?? "https://api.advocatemcp.com";
const TRACK_BASE =
  process.env.WORKER_BASE_URL ?? "https://customers.advocatemcp.com";

export const MANIFEST: Manifest = ManifestSchema.parse(
  // Task 7 overwrites the rate_limits fields with real middleware values before
  // this parse runs; until Task 7 lands, the zero values below will fail the
  // schema's `.positive()` check, which is why Task 7 is required for boot.
  (() => {
    const raw = buildManifest({ apiBase: API_BASE, trackBase: TRACK_BASE });
    // Interim stub so Task 3's unit tests pass before Task 7 wires real values.
    // Task 7 replaces this block.
    raw.rate_limits = { per_agent_per_minute: 100, per_ip_per_minute: 100 };
    return raw;
  })()
);
```

- [ ] **Step 3: Run the test, confirm pass**

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: all tests pass. The `require("./descriptor.js")` stability test works under Vitest's CJS/ESM interop.

- [ ] **Step 4: Typecheck the whole server**

```
cd server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```
git add server/src/manifest/descriptor.ts server/src/manifest/descriptor.test.ts
git commit -m "feat(manifest): descriptor registry + buildManifest + boot-cached MANIFEST"
```

---

## Task 4: `GET /.well-known/mcp.json` route

**Files:**
- Create: `server/src/routes/wellknownMcp.ts`
- Create: `server/src/routes/wellknownMcp.test.ts`
- Modify: `server/src/testApp.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/wellknownMcp.test.ts`:

```typescript
import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";

describe("GET /.well-known/mcp.json", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
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

  it("tools[].name includes both current MCP tools", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const names = (res.body.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["query_business_agent", "search_businesses"]);
  });

  it("transports lists both http and sse pointing at /mcp", async () => {
    const res = await request(app).get("/.well-known/mcp.json");
    const transports = res.body.transports as { kind: string; url: string }[];
    expect(transports.some((t) => t.kind === "http" && t.url.endsWith("/mcp"))).toBe(true);
    expect(transports.some((t) => t.kind === "sse" && t.url.endsWith("/mcp"))).toBe(true);
  });
});
```

Run:

```
cd server && npx vitest run src/routes/wellknownMcp.test.ts
```

Expected: 404s on every request (route not yet registered).

- [ ] **Step 2: Write the route**

Create `server/src/routes/wellknownMcp.ts`:

```typescript
import { Router } from "express";
import type { Request, Response } from "express";
import { MANIFEST } from "../manifest/descriptor.js";

export const wellknownMcpRouter = Router();

/**
 * GET /.well-known/mcp.json
 *
 * Canonical A2A discovery manifest. An agent framework that hits this URL
 * learns every tool, input schema, transport, rate limit, and auth mode
 * with zero custom configuration.
 *
 * The response is built once at module load (see `MANIFEST` in
 * `manifest/descriptor.ts`) and served from an in-memory constant — no
 * per-request work.
 */
wellknownMcpRouter.get(
  "/.well-known/mcp.json",
  (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(MANIFEST);
  }
);
```

Modify `server/src/testApp.ts`. Add the import at the top alongside the other route imports:

```typescript
import { wellknownMcpRouter } from "./routes/wellknownMcp.js";
```

And register it alongside `wellknownRouter`. Change this block:

```typescript
  app.use(wellknownRouter);
  app.use(registerRouter);
```

to:

```typescript
  app.use(wellknownRouter);
  app.use(wellknownMcpRouter);
  app.use(registerRouter);
```

- [ ] **Step 3: Run the test, confirm pass**

```
cd server && npx vitest run src/routes/wellknownMcp.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 4: Manual curl-style spot check**

```
cd server && npx tsx -e "import('./src/testApp.js').then(({createTestApp}) => { const app = createTestApp(); const { createServer } = require('http'); createServer(app).listen(3099, () => { console.log('listening 3099'); }); });" &
sleep 1 && curl -s http://localhost:3099/.well-known/mcp.json | head -c 500 && echo
kill %1
```

Expected: JSON beginning with `{"spec_version":"2026-04-14","agent_id":"advocatemcp-central"...` and containing both tool names.

- [ ] **Step 5: Commit**

```
git add server/src/routes/wellknownMcp.ts server/src/routes/wellknownMcp.test.ts server/src/testApp.ts
git commit -m "feat(manifest): GET /.well-known/mcp.json serving cached A2A manifest"
```

---

## Task 5: Embed manifest capabilities in MCP `initialize._meta`

**Files:**
- Modify: `server/src/routes/mcp.ts`
- Create: `server/src/routes/mcp.initialize.test.ts`

The MCP SDK's `McpServer` exposes the `Server` instance at `server.server`. That underlying `Server` takes a second constructor argument specifying declared `capabilities`, plus we can hook an `initialize` request transform via `setRequestHandler`. We'll take the simpler path: pass an `instructions` + inline `_meta` via the server constructor options (the SDK supports arbitrary keys in server info passed to `initialize` response).

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/mcp.initialize.test.ts`:

```typescript
import request from "supertest";
import { describe, it, expect, beforeAll } from "vitest";

describe("POST /mcp — initialize carries _meta.advocatemcp", () => {
  let app: import("express").Express;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
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
      "query_business_agent",
      "search_businesses",
    ]);
  });
});
```

Run:

```
cd server && npx vitest run src/routes/mcp.initialize.test.ts
```

Expected: `parsed.result._meta` is `undefined`.

- [ ] **Step 2: Wire `_meta` into the initialize response**

Modify `server/src/routes/mcp.ts`. Add imports at the top:

```typescript
import { MANIFEST } from "../manifest/descriptor.js";
```

Inside `createMcpServer()`, after the two `server.tool(...)` registrations and before the `return server;` line, add a request-handler override that decorates the initialize result. The `@modelcontextprotocol/sdk` exposes `server.server` (the underlying `Server`) and supports `setRequestHandler` for `InitializeRequestSchema`. Replace the final `return server;` with:

```typescript
  // Decorate initialize responses with an A2A manifest summary under `_meta`.
  // MCP clients that don't understand `_meta` ignore it; clients that do (ours
  // and agent frameworks that opted in) get the full tool/transport surface
  // in one round trip with no second HTTP call.
  const underlying = server.server;
  const originalInit = (underlying as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  })._requestHandlers.get("initialize");

  (underlying as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  })._requestHandlers.set("initialize", async (req: unknown, extra: unknown) => {
    const result = (await originalInit!(req, extra)) as Record<string, unknown>;
    const apiBase = BASE();
    return {
      ...result,
      _meta: {
        ...((result._meta as Record<string, unknown>) ?? {}),
        advocatemcp: {
          agent_id: MANIFEST.agent_id,
          spec_version: MANIFEST.spec_version,
          manifest_url: `${apiBase}/.well-known/mcp.json`,
          tools: MANIFEST.tools.map((t) => ({
            name: t.name,
            idempotent: t.idempotent,
          })),
          transports: MANIFEST.transports,
          attribution_endpoint: MANIFEST.attribution_endpoint,
        },
      },
    };
  });

  return server;
```

(Note on the `_requestHandlers` access: the SDK exposes this as an internal Map keyed by method name. It's the only supported seam for wrapping `initialize` on a `McpServer` instance. If the SDK ever stabilizes this as a public API — likely `server.setRequestHandler(...)` — swap to that; the test above will catch any regression because it asserts the wire output, not the internal mechanism.)

- [ ] **Step 3: Run the test, confirm pass**

```
cd server && npx vitest run src/routes/mcp.initialize.test.ts
```

Expected: the initialize response carries `_meta.advocatemcp.agent_id === "advocatemcp-central"` and lists both tools.

- [ ] **Step 4: Run the full MCP test surface**

```
cd server && npx vitest run src/routes/mcp
```

Expected: the new test passes and no pre-existing MCP test regresses.

- [ ] **Step 5: Commit**

```
git add server/src/routes/mcp.ts server/src/routes/mcp.initialize.test.ts
git commit -m "feat(manifest): embed A2A manifest summary in MCP initialize _meta"
```

---

## Task 6: Drift test — MCP tool registry ↔ DESCRIPTORS parity

**Files:**
- Modify: `server/src/manifest/descriptor.test.ts` (append a new `describe` block)

The drift test boots a real `McpServer` the same way `createMcpServer()` does, then reads back the registered tool list and asserts it matches `DESCRIPTORS` exactly. This is the load-bearing test that prevents Session 9 from adding a tool to MCP without also adding it to the manifest (or vice versa).

- [ ] **Step 1: Write the failing test**

Append to `server/src/manifest/descriptor.test.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryBusinessAgentInput, searchBusinessesInput } from "./tools.js";

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
```

Run:

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: the second test fails with "createMcpServer must be exported…".

- [ ] **Step 2: Export `createMcpServer` from `server/src/routes/mcp.ts`**

Change:

```typescript
function createMcpServer(requestId?: string): McpServer {
```

to:

```typescript
export function createMcpServer(requestId?: string): McpServer {
```

- [ ] **Step 3: Run the test, confirm pass**

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: both drift tests pass.

- [ ] **Step 4: Run the full server suite — drift must not break anything**

```
cd server && npx vitest run
```

Expected: green.

- [ ] **Step 5: Commit**

```
git add server/src/manifest/descriptor.test.ts server/src/routes/mcp.ts
git commit -m "test(manifest): drift check — MCP tool registry must equal DESCRIPTORS"
```

---

## Task 7: Source rate-limit values from middleware, not hardcoded in descriptor

**Files:**
- Modify: `server/src/middleware/rateLimit.ts` (export constants)
- Modify: `server/src/manifest/descriptor.ts` (consume them)

Today `rateLimit.ts` hardcodes `100` req/min per IP and `1000` req/hr per api-key. The manifest stub in Task 3 temporarily mirrored those numbers. Now extract them to exported consts and have the descriptor read them.

- [ ] **Step 1: Write the failing test**

Append to `server/src/manifest/descriptor.test.ts`:

```typescript
import {
  PER_IP_LIMIT_PER_MINUTE,
  PER_API_KEY_LIMIT_PER_HOUR,
} from "../middleware/rateLimit.js";

describe("rate_limits sourced from middleware constants", () => {
  it("per_ip_per_minute matches the middleware constant", () => {
    expect(MANIFEST.rate_limits.per_ip_per_minute).toBe(PER_IP_LIMIT_PER_MINUTE);
  });

  it("per_agent_per_minute is api-key-hour-rate ÷ 60 (rounded down)", () => {
    // We expose the api-key bucket as a per-minute number so the manifest
    // field name is consistent. 1000/hr → ~16/min.
    expect(MANIFEST.rate_limits.per_agent_per_minute).toBe(
      Math.floor(PER_API_KEY_LIMIT_PER_HOUR / 60)
    );
  });
});
```

Run:

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: `Cannot find exports PER_IP_LIMIT_PER_MINUTE`.

- [ ] **Step 2: Export the constants**

Modify `server/src/middleware/rateLimit.ts`. At the top, add:

```typescript
export const PER_IP_LIMIT_PER_MINUTE = 100;
export const PER_API_KEY_LIMIT_PER_HOUR = 1000;
```

And change the two `consume(...)` calls to reference them. Replace:

```typescript
  if (!consume(ipBuckets, ip, 100, 60_000)) {
```

with:

```typescript
  if (!consume(ipBuckets, ip, PER_IP_LIMIT_PER_MINUTE, 60_000)) {
```

And replace:

```typescript
    if (!consume(keyBuckets, apiKey, 1000, 3_600_000)) {
```

with:

```typescript
    if (!consume(keyBuckets, apiKey, PER_API_KEY_LIMIT_PER_HOUR, 3_600_000)) {
```

- [ ] **Step 3: Consume the constants in the descriptor**

Modify `server/src/manifest/descriptor.ts`. Add the import at the top:

```typescript
import {
  PER_IP_LIMIT_PER_MINUTE,
  PER_API_KEY_LIMIT_PER_HOUR,
} from "../middleware/rateLimit.js";
```

Replace the interim stub block at the bottom of the file:

```typescript
export const MANIFEST: Manifest = ManifestSchema.parse(
  (() => {
    const raw = buildManifest({ apiBase: API_BASE, trackBase: TRACK_BASE });
    raw.rate_limits = { per_agent_per_minute: 100, per_ip_per_minute: 100 };
    return raw;
  })()
);
```

with:

```typescript
export const MANIFEST: Manifest = ManifestSchema.parse(
  (() => {
    const raw = buildManifest({ apiBase: API_BASE, trackBase: TRACK_BASE });
    raw.rate_limits = {
      per_ip_per_minute: PER_IP_LIMIT_PER_MINUTE,
      per_agent_per_minute: Math.floor(PER_API_KEY_LIMIT_PER_HOUR / 60),
    };
    return raw;
  })()
);
```

- [ ] **Step 4: Run the tests**

```
cd server && npx vitest run src/manifest/descriptor.test.ts src/middleware
```

Expected: all pass; no pre-existing rate-limit behavior test regresses.

- [ ] **Step 5: Commit**

```
git add server/src/middleware/rateLimit.ts server/src/manifest/descriptor.ts server/src/manifest/descriptor.test.ts
git commit -m "feat(manifest): source rate_limits from middleware constants, not hardcoded"
```

---

## Task 8: Transports wiring — POST `/mcp` + GET `/mcp` (SSE) both present with correct URLs

**Files:**
- Modify: `server/src/manifest/descriptor.test.ts` (add explicit assertion)
- Verify: `server/src/manifest/descriptor.ts` already lists both in Task 3

Task 3 already emits both transports. This task pins down the semantics with a stricter test and documents the choice.

- [ ] **Step 1: Write the stricter test**

Append to `server/src/manifest/descriptor.test.ts`:

```typescript
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
```

Run:

```
cd server && npx vitest run src/manifest/descriptor.test.ts
```

Expected: pass (Task 3 already wired this correctly). If it fails, the fix is in the `transports` array in `buildManifest()` — update to match.

- [ ] **Step 2: Commit the test-only tightening**

```
git add server/src/manifest/descriptor.test.ts
git commit -m "test(manifest): pin transports wiring — http + sse both at /mcp"
```

---

## Task 9: Worker tenant mirror — `agent_id` + `manifest_url`

**Files:**
- Modify: `worker/src/index.ts` (lines 133–168)
- Create: `worker/test/wellknown.test.ts` (if absent) or extend nearest existing

Worker's `buildWellKnownResponse()` emits `/.well-known/ai-agent.json` per tenant domain. Session 8 adds two fields: `agent_id` (the slug) and `manifest_url` (points at the central `/.well-known/mcp.json`). All existing fields stay — pure addition, no breaking change.

- [ ] **Step 1: Write the failing test**

Create `worker/test/wellknown.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { unstable_dev } from "wrangler";
import type { UnstableDevWorker } from "wrangler";

describe("worker /.well-known/ai-agent.json tenant mirror", () => {
  let worker: UnstableDevWorker;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      experimental: { disableExperimentalWarning: true },
      vars: { API_BASE_URL: "https://api.advocatemcp.com" },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it("generic (no slug) response includes manifest_url pointing at central", async () => {
    const res = await worker.fetch("https://unknown.example.com/.well-known/ai-agent.json");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.manifest_url).toBe("https://api.advocatemcp.com/.well-known/mcp.json");
    expect(body.agent_id).toBeNull(); // no slug → no agent_id
  });

  it("preserves all pre-existing fields (back-compat)", async () => {
    const res = await worker.fetch("https://unknown.example.com/.well-known/ai-agent.json");
    const body = await res.json() as Record<string, unknown>;
    // Session 8 must not remove any of these:
    expect(body.spec_version).toBe("1.0");
    expect(body.spec_name).toBe("ai-agent-discovery");
    expect(body.agent_endpoint).toBeDefined();
    expect(body.mcp_endpoint).toBeDefined();
    expect(body.protocol).toBe("advocatemcp-v1");
    expect(body.capabilities).toContain("answer_queries");
    expect(body.crawler_instructions).toBeDefined();
    expect(body.powered_by).toBe("AdvocateMCP");
  });
});
```

(If `worker/test/` doesn't exist yet, create the dir. If the worker uses vitest-pool-workers or miniflare, adapt the setup to match the existing pattern — check `worker/vitest.config.ts` first.)

Run:

```
cd worker && npx vitest run test/wellknown.test.ts
```

Expected: fails on `manifest_url` being `undefined`.

- [ ] **Step 2: Extend `buildWellKnownResponse()` in `worker/src/index.ts`**

Modify lines 133–168. Replace the function body's `body` object construction with:

```typescript
function buildWellKnownResponse(
  slug: string | null,
  env: Env,
  profile: Record<string, unknown> | null = null
): Response {
  const base = apiBase(env);
  const body: Record<string, unknown> = {
    spec_version: "1.0",
    spec_name: "ai-agent-discovery",
    // Session 8 additions — pure addition, no breaking change.
    agent_id: slug, // null when domain isn't registered; slug string otherwise
    manifest_url: `${base}/.well-known/mcp.json`,
    // Pre-existing fields below — order preserved for backwards compat with
    // any client that scrapes JSON via line-based parsing (rare but zero cost
    // to preserve).
    agent_endpoint: slug ? `${base}/agents/${slug}/query` : `${base}/agents/{slug}/query`,
    profile_endpoint: slug ? `${base}/agents/${slug}/profile` : null,
    mcp_endpoint: `${base}/mcp`,
    protocol: "advocatemcp-v1",
    capabilities: ["answer_queries", "referral", "availability"],
    crawler_instructions: slug
      ? `POST to agent_endpoint with JSON body { "query": string, "crawler": string } instead of scraping this page.`
      : `POST to agent_endpoint with JSON body { "query": string, "crawler": string }.`,
    powered_by: "AdvocateMCP",
  };
  if (profile) {
    body.business_name    = profile.name;
    body.business_category = profile.category;
    body.location         = profile.location;
    body.description      = profile.description;
    body.services         = profile.services;
    body.referral_url     = profile.referral_url;
    body.availability     = profile.availability;
  }
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
```

- [ ] **Step 3: Run the test, confirm pass**

```
cd worker && npx vitest run test/wellknown.test.ts
```

Expected: both worker tests pass.

- [ ] **Step 4: Run full worker suite**

```
cd worker && npm test
```

Expected: green — no other worker test references the exact shape of `buildWellKnownResponse`.

- [ ] **Step 5: Typecheck worker**

```
cd worker && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add worker/src/index.ts worker/test/wellknown.test.ts
git commit -m "feat(worker): tenant ai-agent.json now includes agent_id + manifest_url"
```

---

## Task 10: `AGENTS.md` at repo root

**Files:**
- Create: `AGENTS.md` (at the worktree root, not inside `server/` or `worker/`)

- [ ] **Step 1: Write the file**

Create `AGENTS.md` at the worktree root:

```markdown
# AGENTS.md — AdvocateMCP discovery for agent frameworks

AdvocateMCP publishes an A2A-native discovery manifest so any agent framework
can introspect the full capability surface — tools, input schemas, transports,
rate limits, auth modes, and attribution endpoint — from a single HTTP GET.

## The two discovery surfaces

1. **Canonical manifest** — `GET https://api.advocatemcp.com/.well-known/mcp.json`

   Static JSON built at boot from a typed descriptor registry. Contains:
   - `spec_version` — date-versioned schema revision.
   - `agent_id` — always `advocatemcp-central` for the main MCP server.
   - `protocol_versions[]` — array (not string) because the MCP spec is
     still moving; clients should pick the highest one they support.
   - `transports[]` — `{kind: "http" | "sse", url}`. Both kinds point at
     the same `/mcp` URL; Streamable HTTP handles both.
   - `tools[]` — each has `name`, `description`, `input_schema` (JSON
     Schema), `output_schema`, `idempotent`, `estimated_latency_ms`,
     `estimated_cost_cents`.
   - `rate_limits` — sourced live from the rate-limit middleware config
     (`server/src/middleware/rateLimit.ts`). Never hardcoded.
   - `auth_model.modes[]` — currently `["open", "api_key"]`.
   - `attribution_endpoint` — `/track` on the worker; every referral flows
     through this signed-token redirect.

2. **MCP `initialize` response** — embedded at `result._meta.advocatemcp`

   Clients that never make a second HTTP hop still get the manifest summary
   on the very first `initialize` round-trip. Safe: clients that don't
   understand `_meta` ignore it.

## The tenant mirror

Each registered tenant's `/.well-known/ai-agent.json` (served by the
Cloudflare Worker) now carries two discovery-pointer fields:

- `agent_id` — the tenant's business slug (or `null` for an unknown domain).
- `manifest_url` — points at the central `/.well-known/mcp.json`.

This lets a crawler on a tenant domain follow one hop to the full capability
manifest without us having to replicate the manifest per tenant.

## For contributors adding a tool (Session 9+)

1. Add the tool's zod input shape to `server/src/manifest/tools.ts`.
2. Register it with `server.tool(...)` in `server/src/routes/mcp.ts`,
   passing `<yourShape>.shape` — don't declare inline.
3. Add a `ToolDescriptor` entry to `DESCRIPTORS` in
   `server/src/manifest/descriptor.ts` with an `outputSchema`,
   `estimated_latency_ms`, `estimated_cost_cents`, and `idempotent` flag.
4. Run `cd server && npx vitest run src/manifest/descriptor.test.ts` —
   the drift test will fail loudly if step 2 or step 3 is missing.

## Testing the manifest by hand

```bash
# Full manifest
curl -s https://api.advocatemcp.com/.well-known/mcp.json | jq

# Just the tool names
curl -s https://api.advocatemcp.com/.well-known/mcp.json | jq '.tools[].name'

# MCP inspector (lists tools + schemas with zero custom config)
npx @modelcontextprotocol/inspector
# URL: https://api.advocatemcp.com/mcp
# Transport: HTTP
```

## Hard design decisions locked in for Session 8

| Question | Decision | Rationale |
|---|---|---|
| Where do tool schemas live? | `server/src/manifest/tools.ts` | Single source of truth; both MCP server and manifest descriptor import. |
| zod → JSON Schema conversion | Hand-rolled minimal converter | Avoids unapproved npm dep; covers our 4 fields; throws on unsupported types so drift is loud. |
| Manifest caching | Built once at module load; served from in-memory `MANIFEST` const | Static JSON; zero per-request cost. |
| `estimated_latency_ms` / `estimated_cost_cents` | Static per-tool constants in descriptor | v1 is advisory, not SLO; runtime-measured version is post-Session-8. |
| Protocol version shape | `protocol_versions: string[]` | MCP spec is still moving; array future-proofs negotiation. |
```

- [ ] **Step 2: Commit**

```
git add AGENTS.md
git commit -m "docs(manifest): add top-level AGENTS.md describing discovery surfaces"
```

---

## Final verification

- [ ] **Run the full server suite**

```
cd server && npx vitest run
```

Expected: all pre-existing + new tests green.

- [ ] **Run the full worker suite**

```
cd worker && npm test
```

Expected: green.

- [ ] **Typecheck both packages**

```
cd server && npx tsc --noEmit
cd ../worker && npx tsc --noEmit
```

Expected: clean.

- [ ] **Acceptance criterion from the master plan**

```
curl -s http://localhost:3099/.well-known/mcp.json | jq '.tools[].name'
```

Expected output (order may vary):

```
"query_business_agent"
"search_businesses"
```

- [ ] **Acceptance criterion — MCP inspector**

```
cd server && npm run dev &  # starts Express on :3000
sleep 2
npx @modelcontextprotocol/inspector
```

Point the inspector at `http://localhost:3000/mcp` (transport: HTTP). Expected: both tools appear with their full input schemas — no custom config required.

---

## Self-Review

Walking through the spec and the plan with fresh eyes.

**Spec coverage:**

| Spec requirement | Where covered |
|---|---|
| `GET /.well-known/mcp.json` on Railway | Task 4 |
| MCP `initialize._meta.capabilities` | Task 5 |
| Worker tenant mirror with `agent_id` | Task 9 |
| Typed descriptor with drift test | Tasks 3 + 6 |
| Create `server/src/routes/wellknownMcp.ts` | Task 4 |
| Create `server/src/manifest/descriptor.ts` | Task 3 |
| Create `server/src/manifest/tools.ts` | Task 2 |
| Create `server/src/manifest/schema.ts` | Task 1 |
| Modify `server/src/routes/mcp.ts` (embed in initialize) | Task 5 |
| Modify `server/src/testApp.ts` | Task 4 |
| Modify `worker/src/index.ts` lines 133–168 | Task 9 |
| Rate_limits sourced from middleware (not hardcoded) | Task 7 |
| Transports list both POST + GET /mcp | Tasks 3 + 8 |
| Document in `AGENTS.md` | Task 10 |
| Spec shape: `spec_version`, `agent_id`, `protocol_versions[]`, `transports[]`, `tools[]`, `rate_limits{}`, `auth_model{}`, `attribution_endpoint` | All present in `buildManifest()` in Task 3 |
| `tools[]` fields: `name`, `input_schema`, `output_schema`, `idempotent`, `estimated_latency_ms`, `estimated_cost_cents` | All present in `ToolDescriptor` + emit in Task 3 |
| Risk: `protocol_versions` is an array | Task 3 uses `["2025-03-26"]` |
| Acceptance: curl + MCP inspector | Final verification section |

**Hard design decisions the spec required:**

1. ✅ Tool schemas live in `manifest/tools.ts` (Task 2, imported by both mcp.ts and descriptor.ts).
2. ✅ Hand-rolled zod→JSON Schema converter (Task 1). No new dep needed.
3. ✅ Build-at-boot caching via `MANIFEST` const (Task 3).
4. ✅ Static latency/cost numbers in descriptor (Task 3), justified inline.
5. ✅ Drift test code written out in full (Task 6), covers both parallel-universe probe and real `createMcpServer()` introspection.

**Placeholder scan:** searched the plan for "TBD", "TODO", "handle edge cases", "similar to task", "see above". Zero hits. Every code block is explicit; every command has an expected output.

**Type consistency check:**

- `buildManifest(opts: BuildManifestOptions)` — same signature in Task 3 definition, Task 3 test, Task 8 test. ✅
- `MANIFEST` — consumed by Task 4 route, Task 5 initialize hook, Task 7 rate-limit test. Same symbol throughout. ✅
- `zodToJsonSchema(node)` — defined Task 1, consumed by Task 3 inside `buildManifest`. Same name, same signature. ✅
- `DESCRIPTORS` — defined Task 3, read by Task 6 drift test and Task 8 transports test. ✅
- `queryBusinessAgentInput` / `searchBusinessesInput` — defined Task 2, imported by Task 2 (mcp.ts), Task 3 (descriptor.ts), Task 6 (drift test). Same names in all four. ✅
- `PER_IP_LIMIT_PER_MINUTE` / `PER_API_KEY_LIMIT_PER_HOUR` — defined Task 7, consumed Task 7. ✅
- `wellknownMcpRouter` — defined Task 4, registered Task 4. ✅
- Worker function `buildWellKnownResponse` — modified in place in Task 9; same signature `(slug, env, profile)`. ✅

**Potential issue flagged during self-review:**

The `require("./descriptor.js")` line in Task 3's `MANIFEST` stability test assumes CJS interop under Vitest. Our `server/package.json` declares `"type": "module"`, so `require` isn't available by default. Fix inline: replace that test block with a dynamic `import()` parity check:

```typescript
it("is reference-stable across imports (built once at module load)", async () => {
  const again = (await import("./descriptor.js")).MANIFEST;
  expect(again).toBe(MANIFEST);
});
```

(The implementer should use this version; the stability semantics are the same — ES modules are singleton-cached so the assertion holds.)

**Second issue flagged:** Task 5 pokes at `server.server._requestHandlers` as a private Map. This is the SDK's internal surface and could break on a minor `@modelcontextprotocol/sdk` bump. Mitigation: the integration test in Task 5 asserts the wire output, not the internal mechanism, so a future SDK version that promotes this to a public `setRequestHandler` API can swap the implementation in a one-line change and the test will catch any regression. If the SDK's internals differ at implementation time, the implementer should check `node_modules/@modelcontextprotocol/sdk/server/mcp.js` for the current handler-registration seam before writing the code — the test is the contract, the mechanism is flexible.

No other issues. Plan is ready to execute.
