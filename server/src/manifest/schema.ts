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
