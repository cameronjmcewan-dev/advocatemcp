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
