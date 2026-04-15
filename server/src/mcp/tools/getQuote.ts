import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../db.js";
import { getQuoteInput } from "../../manifest/tools.js";

export interface PricingRange {
  service: string;
  low: number;
  high: number;
  currency: string;
  params?: Record<string, string>;
}
export interface PricingJson { ranges: PricingRange[] }

export interface Quote {
  low: number;
  high: number;
  currency: string;
  confidence: "exact" | "range" | "estimate";
  basis: "pricing_json_v2" | "llm_estimate";
  disclaimer?: string;
}

const norm = (s: string) => s.trim().toLowerCase();

function paramsMatch(required: Record<string, string> | undefined, given: Record<string, string>): boolean {
  if (!required) return Object.keys(given).length === 0;
  for (const [k, v] of Object.entries(required)) {
    if (given[k] !== v) return false;
  }
  return true;
}

/**
 * Deterministic quote. Returns null on miss; Task 6 wraps this with the LLM fallback.
 * Confidence: "exact" when low === high, "range" otherwise. Never returns "estimate".
 */
export function deterministicQuote(
  args: { service: string; params: Record<string, string> },
  pricing: PricingJson
): Quote | null {
  const target = norm(args.service);
  for (const r of pricing.ranges) {
    if (norm(r.service) !== target) continue;
    if (!paramsMatch(r.params, args.params)) continue;
    return {
      low: r.low,
      high: r.high,
      currency: r.currency,
      confidence: r.low === r.high ? "exact" : "range",
      basis: "pricing_json_v2",
    };
  }
  return null;
}

export async function handleGetQuote(
  input: z.infer<typeof getQuoteInput>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const row = getDb().prepare(`
    SELECT pricing_json_v2 FROM businesses WHERE slug = ?
  `).get(input.slug) as { pricing_json_v2: string | null } | undefined;

  if (!row) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "business_not_found", slug: input.slug }) }] };
  }
  let pricing: PricingJson = { ranges: [] };
  if (row.pricing_json_v2) {
    try { pricing = JSON.parse(row.pricing_json_v2) as PricingJson; } catch { pricing = { ranges: [] }; }
  }
  const det = deterministicQuote({ service: input.service, params: input.params ?? {} }, pricing);
  if (det) {
    return { content: [{ type: "text", text: JSON.stringify({ quote: det }) }] };
  }
  // Task 6 replaces this with the LLM fallback.
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ quote: null, reason: "no_deterministic_match" }),
    }],
  };
}

export function registerGetQuote(server: McpServer): void {
  server.tool(
    "get_quote",
    "Quote price for a service at a business. Deterministic lookup of pricing_json_v2.ranges[]; returns null on miss (LLM fallback in next commit).",
    getQuoteInput.shape,
    async (args) => handleGetQuote(args)
  );
}
