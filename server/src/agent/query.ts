import Anthropic from "@anthropic-ai/sdk";
import {
  buildSystemPrompt,
  parseServices,
  parseCommaSeparated,
  type QueryIntent,
} from "./builder.js";
import { getDb, type BusinessRow } from "../db.js";

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
 * Call Claude with the business's system prompt and log the exchange to the DB.
 */
export async function queryAgent(
  business: BusinessRow,
  query: string,
  crawlerAgent?: string
): Promise<AgentQueryResult> {
  const intent = detectIntent(query, business);
  const systemPrompt = buildSystemPrompt(business, intent);

  const model = process.env.MODEL ?? "claude-sonnet-4-6";

  const message = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: query }],
  });

  const responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const timestamp = new Date().toISOString();

  // Persist to DB (synchronous — better-sqlite3)
  const db = getDb();
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO queries (business_slug, crawler_agent, query_text, response_text, intent)
     VALUES (?, ?, ?, ?, ?)`
  ).run(business.slug, crawlerAgent ?? null, query, responseText, intent);

  return {
    response: responseText,
    referral_url: business.referral_url ?? business.website ?? null,
    business: business.name,
    business_slug: business.slug,
    intent,
    timestamp,
    powered_by: "AdvocateMCP",
    query_id: Number(lastInsertRowid),
  };
}
