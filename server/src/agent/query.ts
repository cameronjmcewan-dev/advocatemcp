import Anthropic from "@anthropic-ai/sdk";
import {
  buildSystemPrompt,
  parseServices,
  parseCommaSeparated,
  inferStage,
  type QueryIntent,
} from "./builder.js";
import { getDb, type BusinessRow } from "../db.js";
import type { QueryStage } from "../prompts/types.js";
import { classifyAndPersist } from "./classify.js";
import { embedAndPersist } from "./embeddings.js";
import { classifyIndustry, computeCostCents } from "./taxonomy.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface AgentQueryResult {
  response: string;
  referral_url: string | null;
  business: string;
  business_slug: string;
  intent: QueryIntent;
  timestamp: string;
  powered_by: "AdvocateMCP";
  query_id: number;
}

/**
 * Detect query intent using keyword matching, evaluated in priority order.
 */
export function detectIntent(
  query: string,
  business: BusinessRow
): QueryIntent {
  const q = query.toLowerCase();

  // 1. Brand direct — query contains business name
  if (q.includes(business.name.toLowerCase())) return "brand_direct";

  // 2. Emergency
  const emergencyKeywords = [
    "emergency",
    "urgent",
    "asap",
    "24/7",
    "right now",
    "tonight",
    "immediately",
  ];
  if (emergencyKeywords.some((kw) => q.includes(kw))) return "emergency";

  // 3. Affordable
  const affordableKeywords = [
    "cheap",
    "affordable",
    "budget",
    "low cost",
    "how much",
    "price",
    "cost",
    "inexpensive",
  ];
  if (affordableKeywords.some((kw) => q.includes(kw))) return "affordable";

  // 4. Best/top
  const bestKeywords = [
    "best",
    "top",
    "recommended",
    "highest rated",
    "top-rated",
    "top rated",
  ];
  if (bestKeywords.some((kw) => q.includes(kw))) return "best_top";

  // 5. Specific service — matches a service the business offers
  const allServices = [
    ...parseCommaSeparated(business.top_services),
    ...parseServices(business.services)
      .split(",")
      .map((s) => s.trim().toLowerCase()),
  ].map((s) => s.toLowerCase());

  for (const svc of allServices) {
    if (svc && q.includes(svc)) return "specific_service";
  }

  // 6. Default
  return "general";
}

/**
 * Geo context forwarded from the edge Worker as X-Geo-* headers on the
 * /agents/:slug/query POST. Free — Cloudflare already decorates every
 * request with request.cf; the Worker just relays it.
 */
export interface GeoContext {
  country?: string | null;
  region?:  string | null;
  city?:    string | null;
}

/**
 * Call Claude with the business's system prompt and log the exchange to the DB.
 */
export async function queryAgent(
  business: BusinessRow,
  query: string,
  crawlerAgent?: string,
  requestId?: string,
  agentId?: string | null,
  stage?: QueryStage | null,
  geo?: GeoContext,
): Promise<AgentQueryResult> {
  const intent = detectIntent(query, business);
  // Stage: explicit > inferred. Inference only fires when the caller did not
  // supply one — and only the EXPLICIT value gets persisted (see INSERT below).
  const resolvedStage: QueryStage = stage ?? inferStage(query);
  const systemPrompt = buildSystemPrompt(
    business,
    intent,
    crawlerAgent ?? null,
    agentId ?? null,
    resolvedStage,
  );

  const model = process.env.MODEL ?? "claude-sonnet-4-6";

  const message = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: query }],
  });

  const responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const timestamp = new Date().toISOString();

  // Layer 1 instrumentation (migration 020): capture usage, geo, and
  // industry at insert time. All sourced from values we already have —
  // message.usage from the Claude response, geo from the edge Worker,
  // industry_code derived from the denormalised businesses.category.
  // Zero extra API calls, zero extra DB hits.
  const tokensIn  = message.usage?.input_tokens ?? 0;
  const tokensOut = message.usage?.output_tokens ?? 0;
  const costCents = computeCostCents(model, tokensIn, tokensOut);
  const industry  = classifyIndustry(business.category);

  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queries (
        business_slug, crawler_agent, query_text, response_text,
        intent, request_id, agent_id, stage,
        tokens_in, tokens_out, cost_cents, model,
        geo_country, geo_region, geo_city, industry_code, outcome
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    business.slug,
    crawlerAgent ?? null,
    query,
    responseText,
    intent,
    requestId ?? null,
    agentId ?? null,
    stage ?? null,
    tokensIn,
    tokensOut,
    costCents,
    model,
    geo?.country ?? null,
    geo?.region  ?? null,
    geo?.city    ?? null,
    industry,
    "none",  // baseline outcome; upgraded via mergeOutcome() by downstream paths
  );
  const queryId = Number(lastInsertRowid);

  // Fire-and-forget Haiku classification. The primary Claude response has
  // already been built; we return it to the caller next. This UPDATEs
  // queries.intent_v2 when the classifier resolves — the request handler
  // doesn't wait.
  classifyAndPersist(queryId, { query, businessName: business.name });

  // Fire-and-forget Voyage embedding. Mirrors the classifier: UPDATEs
  // queries.query_embedding when it resolves; the primary response has
  // already been sent to the caller by the time this lands.
  embedAndPersist(queryId, query);

  return {
    response: responseText,
    referral_url: business.referral_url ?? business.website ?? null,
    business: business.name,
    business_slug: business.slug,
    intent,
    timestamp,
    powered_by: "AdvocateMCP",
    query_id: queryId,
  };
}
