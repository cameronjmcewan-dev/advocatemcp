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
  | { type: "string"; description?: string; minLength?: number; enum?: string[] }
  | { type: "number"; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items?: JsonSchemaNode; description?: string }
  | {
      type: "object";
      properties?: Record<string, JsonSchemaNode>;
      required?: string[];
      additionalProperties?: false | JsonSchemaNode;
      description?: string;
    }
  | { const: unknown }
  | { oneOf: JsonSchemaNode[] };

export function zodToJsonSchema(node: ZodTypeAny): JsonSchemaNode {
  // `_def` is a zod internal — stable across the 3.23 line we depend on. If
  // zod v4 renames `typeName`, this converter fails loudly at test time via
  // the unsupported-type throw below rather than silently emitting wrong JSON.
  const def = node._def as {
    typeName: string;
    description?: string;
    checks?: Array<{ kind: string; value?: number }>;
    innerType?: ZodTypeAny;
    shape?: () => Record<string, ZodTypeAny>;
    valueType?: ZodTypeAny;
  };

  // Unwrap ZodOptional by recursing into innerType — optionality is a
  // property of the parent object's `required[]`, not the field itself.
  if (def.typeName === "ZodOptional" && def.innerType) {
    return zodToJsonSchema(def.innerType);
  }

  // ZodEffects wraps an inner schema with a .refine()/.transform() — the
  // runtime check is invisible to JSON Schema consumers, so we just unwrap
  // and emit the inner shape. Refinements like "email or phone required" on
  // request_callback's contact are enforced at zod parse time, not in the
  // published manifest.
  if (def.typeName === "ZodEffects") {
    const schema = (def as { schema?: ZodTypeAny }).schema;
    if (schema) return zodToJsonSchema(schema);
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

  if (def.typeName === "ZodNumber") {
    const out: JsonSchemaNode = { type: "number" };
    if (def.description) out.description = def.description;
    return out;
  }

  if (def.typeName === "ZodBoolean") {
    const out: JsonSchemaNode = { type: "boolean" };
    if (def.description) out.description = def.description;
    return out;
  }

  // ZodArray — used by subscribe_to_updates.topics. zod stores the element
  // type at `_def.type`. We don't surface min/max bounds in JSON Schema today
  // (zod's `.min(1)` is a runtime check; agents that consume the manifest
  // for client-side validation get the constraint at parse time, not as a
  // schema-level keyword).
  if (def.typeName === "ZodArray") {
    const innerArr = (def as { type?: ZodTypeAny }).type;
    if (!innerArr) throw new Error("zodToJsonSchema: ZodArray missing element type");
    const out: JsonSchemaNode = { type: "array", items: zodToJsonSchema(innerArr) };
    if (def.description) out.description = def.description;
    return out;
  }

  if (def.typeName === "ZodRecord") {
    if (!def.valueType) throw new Error(`zodToJsonSchema: ZodRecord missing valueType`);
    return {
      type: "object",
      additionalProperties: zodToJsonSchema(def.valueType),
    };
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

  if (def.typeName === "ZodEnum") {
    // zod stores the enum members at `_def.values`. Always strings (zod's
    // ZodEnum is string-only; for numeric enums it surfaces as ZodNativeEnum,
    // which we don't use today).
    const values = (def as { values?: string[] }).values ?? [];
    const out: JsonSchemaNode = { type: "string", enum: values };
    if (def.description) out.description = def.description;
    return out;
  }

  if (def.typeName === "ZodLiteral") {
    const value = (def as { value?: unknown }).value;
    return { const: value } as JsonSchemaNode;
  }

  if (def.typeName === "ZodDiscriminatedUnion") {
    const options = (def as { options?: ZodTypeAny[] }).options ?? [];
    return { oneOf: options.map((o) => zodToJsonSchema(o)) } as JsonSchemaNode;
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
      // MCP spec behavioral hints — surfaced so A2A manifest consumers see
      // the same readOnly/destructive/openWorld signal as `tools/list`.
      annotations: z.object({
        readOnlyHint: z.boolean(),
        destructiveHint: z.boolean(),
        openWorldHint: z.boolean(),
      }),
    })
  ),
  rate_limits: z.object({
    per_agent_per_minute: z.number().int().positive(),
    per_ip_per_minute: z.number().int().positive(),
    // Session 11: tiered ceilings keyed on agent reputation. Optional so a
    // bare `{per_agent_per_minute, per_ip_per_minute}` parses (back-compat).
    tiers: z
      .object({
        unverified: z.number().int().positive(),
        known: z.number().int().positive(),
        trusted: z.number().int().positive(),
      })
      .optional(),
  }),
  auth_model: z.object({
    modes: z.array(
      z.enum(["open", "api_key", "oauth2.1_client_credentials_preview"])
    ),
  }),
  attribution_endpoint: z.string().url(),
  // Compliance/contact surfaces required by the ChatGPT Apps SDK review
  // process. Agent frameworks also surface these to end users.
  support_contact: z.string().min(1),
  privacy_url: z.string().url(),
  terms_url: z.string().url(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
