import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./builder.js";
import { getDb, type BusinessRow } from "../db.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface AgentQueryResult {
  response: string;
  referral_url: string | null;
  business: string;
  powered_by: "AdvocateMCP";
}

/**
 * Call Claude with the business's system prompt and log the exchange to the DB.
 */
export async function queryAgent(
  business: BusinessRow,
  query: string,
  crawlerAgent?: string
): Promise<AgentQueryResult> {
  const systemPrompt = buildSystemPrompt(business);

  const message = await anthropic.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: query }],
  });

  const responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Persist to DB (synchronous — better-sqlite3)
  const db = getDb();
  db.prepare(
    `INSERT INTO queries (business_slug, crawler_agent, query_text, response_text)
     VALUES (?, ?, ?, ?)`
  ).run(business.slug, crawlerAgent ?? null, query, responseText);

  return {
    response: responseText,
    referral_url: business.referral_url ?? business.website ?? null,
    business: business.name,
    powered_by: "AdvocateMCP",
  };
}
