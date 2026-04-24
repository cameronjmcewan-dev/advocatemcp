/**
 * Async intent classification for the Layer 1 instrumentation pipeline.
 *
 * Runs Haiku against the query text AFTER the primary agent response is
 * returned to the caller, then UPDATEs queries.intent_v2 in place.
 * Explicitly fire-and-forget from the request handler's perspective —
 * latency here doesn't affect user-facing response times.
 *
 * Cost math: Haiku input ~0.8c/Mtok, output ~4c/Mtok. Classifying a 20-word
 * query (~30 tokens in, ~5 tokens out) costs ~0.000024c per call — about
 * $0.24 per million classifications. Cheaper than the DB insert.
 */

import Anthropic from "@anthropic-ai/sdk";
import { INTENT_V2, isIntentV2, computeCostCents, type IntentV2 } from "./taxonomy.js";
import { getDb } from "../db.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "claude-haiku-4-5";

const SYSTEM_PROMPT = `You classify the intent of customer queries to a local business.

Respond with exactly ONE value from this list (lowercase, no punctuation, no explanation):
${INTENT_V2.join(", ")}

Guidance:
- "brand" only when the query NAMES the specific business by name
- "pricing" for cost/price/quote/how much questions
- "hours" for "when open", "schedule", "available", hours/days questions
- "location" for "where", "nearby", address questions
- "emergency" for urgent/same-day/24hr/right-now phrasings
- "comparison" when weighing two+ options ("vs", "better than", "or")
- "service" when asking about a specific named service
- "reviews" when asking about ratings/reputation/quality perceptions
- "contact" when asking how to reach the business (call, email, book)
- "research" for early-funnel info gathering without a buying signal
- "other" when none above fit cleanly

Output: a single token from the list above. Nothing else.`;

export interface ClassifyInput {
  query: string;
  // Optional context: when we know the business name, ambiguous queries
  // are easier to split between "brand" and "service/comparison." Passing
  // it in the user message rather than the system block keeps the system
  // prompt cache-hot across tenants.
  businessName?: string;
}

export interface ClassifyResult {
  intent: IntentV2;
  tokens_in: number;
  tokens_out: number;
  cost_cents: number;
  model: string;
}

/**
 * Classify a single query. Throws on API error — callers are expected to
 * catch and log since this runs async.
 */
export async function classifyIntent(input: ClassifyInput): Promise<ClassifyResult> {
  const userContent = input.businessName
    ? `Business: ${input.businessName}\n\nQuery: ${input.query}`
    : `Query: ${input.query}`;

  const message = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 10, // single token output; 10 is a generous ceiling
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const raw = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .toLowerCase();

  // Haiku occasionally adds a period or quotes. Strip punctuation before
  // validating — if it still doesn't match the enum, fall back to "other".
  const stripped = raw.replace(/[.,"'\s]+$/, "").replace(/^["'\s]+/, "");
  const intent: IntentV2 = isIntentV2(stripped) ? stripped : "other";

  const tokensIn  = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;

  return {
    intent,
    tokens_in:  tokensIn,
    tokens_out: tokensOut,
    cost_cents: computeCostCents(CLASSIFIER_MODEL, tokensIn, tokensOut),
    model:      CLASSIFIER_MODEL,
  };
}

/**
 * Fire-and-forget wrapper: classify and UPDATE queries.intent_v2. Safe to
 * call without awaiting from request handlers. Logs errors to stderr but
 * never throws out.
 *
 * The caller supplies `queryId` — the INTEGER PK of the row we're
 * enriching. If a later row with higher fidelity overwrites, that's fine;
 * the UPDATE uses a no-OP if the row already has intent_v2 set, to avoid
 * undoing a manual correction.
 */
export function classifyAndPersist(
  queryId: number,
  input: ClassifyInput,
): void {
  // Opt-out kill switch. Tests that mock the primary Claude call but don't
  // care about enrichment can set DISABLE_INTENT_CLASSIFIER=true to skip
  // the secondary Haiku round-trip entirely. Production deploys leave it
  // unset and the classifier runs on every query.
  if (process.env.DISABLE_INTENT_CLASSIFIER === "true") return;

  // Set up the Promise but don't await it. `void` the return so static
  // analysers don't flag the unhandled Promise.
  void classifyIntent(input)
    .then((result) => {
      try {
        const db = getDb();
        db.prepare(
          `UPDATE queries
              SET intent_v2 = COALESCE(intent_v2, ?)
            WHERE id = ?`
        ).run(result.intent, queryId);
      } catch (err) {
        // DB hiccup — log and move on. The backfill job will pick the row
        // up on its next pass.
        console.error(JSON.stringify({
          event: "classify_persist_db_error",
          query_id: queryId,
          error: String(err),
        }));
      }
    })
    .catch((err) => {
      console.error(JSON.stringify({
        event: "classify_api_error",
        query_id: queryId,
        error: String(err?.message ?? err),
      }));
    });
}
