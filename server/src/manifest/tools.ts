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
  agent_id: z
    .string()
    .optional()
    .describe(
      "Optional caller-asserted agent identifier (e.g. 'claude-desktop', " +
        "'cursor', 'gpt-agent'). Used to tune the response shape. May be " +
        "overridden by the x-agent-identity header. Self-asserted only in " +
        "v1 — not used for auth or rate limiting."
    ),
  stage: z
    .enum(["browsing", "comparing", "committing"])
    .optional()
    .describe(
      "Optional buyer stage. 'browsing' (default) — exploring options. " +
        "'comparing' — weighing alternatives. 'committing' — ready to act. " +
        "When omitted, the server infers from query verbs (e.g. 'book'/'reserve' → committing)."
    ),
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

export const getAvailabilityInput = z.object({
  slug: z.string().min(1).describe("business slug"),
  window_start: z.number().int().positive().optional().describe("Unix seconds; default now"),
  window_end: z.number().int().positive().optional().describe("Unix seconds; default now + 7 days"),
});
export type GetAvailabilityInput = z.infer<typeof getAvailabilityInput>;

export const getQuoteInput = z.object({
  slug: z.string().min(1).describe("business slug"),
  service: z.string().min(1).describe("requested service name"),
  params: z.record(z.string()).optional().describe("optional service parameters (e.g., {size:'large'})"),
});
export type GetQuoteInput = z.infer<typeof getQuoteInput>;

export const reserveSlotInput = z.object({
  slug: z.string().min(1),
  window_start: z.number().int().positive(),
  window_end: z.number().int().positive(),
  agent_id: z.string().optional(),
  customer_contact: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  idempotency_key: z.string().min(1),
});
export type ReserveSlotInput = z.infer<typeof reserveSlotInput>;

export const initiateHandoffInput = z.discriminatedUnion("mode", [
  z.object({
    slug: z.string().min(1),
    reservation_id: z.string().optional(),
    mode: z.literal("human"),
    payload: z.object({ message: z.string().min(1) }),
  }),
  z.object({
    slug: z.string().min(1),
    reservation_id: z.string().optional(),
    mode: z.literal("agent"),
    payload: z.object({ purpose: z.string().min(1) }),
  }),
]);
export type InitiateHandoffInput = z.infer<typeof initiateHandoffInput>;
