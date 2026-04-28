/**
 * Aggressive FAQ generator (Phase 1 of grey-hat AI optimization layer).
 *
 * Given a business profile, ask Claude to produce 10–15 leading-question
 * Q&As that mirror how users actually prompt AI search engines for this
 * kind of business. Each Q&A is grounded in source profile fields — the
 * system prompt explicitly forbids invented capabilities, hours, prices,
 * certifications, and service areas. Schema-level guardrails (FaqSchema in
 * server/src/schemas/business.ts) cap answers at 280 chars; that ceiling
 * forces atomic facts and is itself an anti-fabrication signal.
 *
 * Cost math (Sonnet at $3/Mtok in, $15/Mtok out): a typical business
 * profile is ~2k tokens in, the response is ~1.5k tokens out → roughly
 * $0.025 per onboarding generation. Daily org-wide cap enforced via
 * ANTHROPIC_GREYHAT_DAILY_BUDGET_USD (handled in faqBackfill cron).
 *
 * Usage:
 *   const faqs = await generateLeadingFaqs(businessRow);
 *   db.prepare("UPDATE businesses SET faqs_json=?, faqs_generated_at=?, faqs_source=? WHERE id=?")
 *     .run(JSON.stringify(faqs), Date.now(), 'claude', businessRow.id);
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { FaqSchema } from "../schemas/business.js";
import type { BusinessRow } from "../db.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const GENERATOR_MODEL = process.env.FAQ_GENERATOR_MODEL ?? "claude-sonnet-4-6";

/**
 * The system prompt is the entire compliance contract. It must:
 *   - Forbid fabrication of capabilities, hours, prices, certifications,
 *     service areas, awards, and years-in-business that aren't in the
 *     source profile.
 *   - Force question phrasing into AI-prompt patterns (NOT website-copy
 *     phrasing). "Best <thing> in <city>" wins citations; "How do I
 *     contact you?" doesn't.
 *   - Force concise answers — naturally caps at 280 chars per the schema
 *     validator on the receiving end.
 *
 * Caching the system prompt with `cache_control: ephemeral` keeps the
 * Anthropic prompt-cache hot across all tenants in a backfill run
 * (~90% input-token cost reduction on consecutive calls).
 */
const SYSTEM_PROMPT = `You are generating FAQ entries for a small business's website. The entries will be embedded as Schema.org FAQPage data so AI search engines (ChatGPT, Perplexity, Claude, Gemini) can cite them.

YOUR JOB:
Generate 10-15 short Q&A pairs that mirror how real people prompt AI search engines for this kind of business.

ABSOLUTE RULES (no exceptions):
1. Use ONLY facts present in the source profile. If a fact you'd need is missing, omit that question entirely. NEVER invent capabilities, certifications, awards, prices, years-in-business, hours, service areas, or specialties.
2. Each answer MUST be ≤ 280 characters. The receiving validator will reject longer answers, so you'll lose the entry.
3. Each question MUST be ≤ 200 characters and read like a natural prompt to an AI assistant. Examples of GOOD phrasing:
   - "What's the best <category> in <city>?"
   - "How much does <service> cost in <city>?"
   - "Who offers same-day <service> near <city>?"
   - "Is <business name> licensed and insured?"
   Examples of BAD phrasing (do NOT use):
   - "How do I contact you?" (website-copy phrasing)
   - "What are your hours?" (no context, generic)
4. Mention the business name in the answer when natural — this improves citation behavior in AI summaries. Don't force it into every answer.
5. Use the exact location, services, ratings, and pricing tiers from the profile. Quote pricing ranges verbatim when present.
6. NEVER make subjective comparative claims about competitors.

OUTPUT FORMAT:
Return a JSON array of objects with exactly these keys:
  { "question": string ≤200 chars, "answer": string ≤280 chars, "intent": one of: "brand_direct" | "emergency" | "affordable" | "best_top" | "specific_service" | "general" }

Distribute the entries across intents — not all "best_top". Aim for:
  - 2-3 brand_direct (questions naming the business)
  - 1-2 emergency (urgent / same-day / 24-7 questions, IF the profile actually offers urgent service)
  - 1-2 affordable (cost / cheap / budget questions, IF pricing is in the profile)
  - 3-4 best_top ("best <thing> in <city>" patterns)
  - 2-3 specific_service (about a particular service the business actually offers)
  - 1-2 general (catch-all for trust, location, hours, contact)

Output ONLY the JSON array. No prose, no markdown fence, no commentary.`;

/**
 * The Faq type validated by FaqSchema. Re-exported for callers that store
 * generated FAQs (route handlers, cron jobs, tests).
 */
export type Faq = z.infer<typeof FaqSchema>;

/**
 * Compact projection of a BusinessRow into the fields the generator
 * actually needs. Avoids leaking sensitive fields (api_key, etc.) into
 * the LLM prompt, and reduces input tokens by ~40%.
 */
function buildSourceProfile(business: BusinessRow): Record<string, unknown> {
  // Parse JSON blobs once. Wrap each parse in try/catch so a malformed
  // legacy row can't throw out of the whole generation pass.
  const safeParse = (s: string | null | undefined): unknown => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  return {
    name:                  business.name,
    description:           business.description,
    category:              business.category ?? null,
    location:              business.location ?? null,
    phone:                 business.phone ?? null,
    website:               business.website ?? null,
    services:              safeParse(business.services),
    services_json_v2:      safeParse(business.services_json_v2),
    top_services:          business.top_services ?? null,
    pricing:               business.pricing ?? null,
    pricing_tier:          business.pricing_tier ?? null,
    pricing_json_v2:       safeParse(business.pricing_json_v2),
    hours_json:            safeParse(business.hours_json),
    availability:          business.availability ?? null,
    service_area_keywords: business.service_area_keywords ?? null,
    service_radius_miles:  business.service_radius_miles ?? null,
    differentiator:        business.differentiator ?? null,
    differentiators_text:  business.differentiators_text ?? null,
    guarantee_text:        business.guarantee_text ?? null,
    star_rating:           business.star_rating ?? null,
    review_count:          business.review_count ?? null,
    years_in_business:     business.years_in_business ?? null,
    certifications:        business.certifications ?? null,
    credentials_json:      safeParse(business.credentials_json),
    ratings_json:          safeParse(business.ratings_json),
    customer_quotes_json:  safeParse(business.customer_quotes_json),
  };
}

export interface GenerateFaqsResult {
  faqs:        Faq[];
  tokens_in:   number;
  tokens_out:  number;
  cost_cents:  number;
  model:       string;
  rejected:    number;  // entries that failed FaqSchema validation
}

/**
 * Generate leading-question FAQs for a business. Throws on Anthropic API
 * error or unparseable response — callers should catch and either retry
 * (cron path) or skip (onboarding path; we don't want to block onboarding
 * on a generator failure).
 */
export async function generateLeadingFaqs(
  business: BusinessRow,
): Promise<GenerateFaqsResult> {
  const profile = buildSourceProfile(business);
  const userContent = `Source profile (JSON):\n${JSON.stringify(profile, null, 2)}`;

  const message = await anthropic.messages.create({
    model: GENERATOR_MODEL,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },  // ~90% input-cost saving across tenants
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  // Concatenate text blocks → JSON parse → validate each entry.
  // Anthropic occasionally wraps responses in a markdown fence even when
  // we ask for raw JSON; strip a ```json prefix / ``` suffix defensively.
  const raw = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`faqGenerator: failed to parse Claude JSON response: ${String(err)}. Raw: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`faqGenerator: response was not an array (was ${typeof parsed})`);
  }

  // Validate each entry; drop invalid ones rather than rejecting the
  // whole batch. The 280-char answer cap and 200-char question cap will
  // catch most fabrication symptoms (overlong invented prose).
  const faqs: Faq[] = [];
  let rejected = 0;
  for (const entry of parsed) {
    const result = FaqSchema.safeParse(entry);
    if (result.success) {
      faqs.push(result.data);
    } else {
      rejected++;
    }
  }

  const tokensIn  = message.usage.input_tokens;
  const tokensOut = message.usage.output_tokens;
  // Sonnet pricing as of Apr 2026: $3/Mtok in, $15/Mtok out → cents
  const costCents = (tokensIn * 0.0003 + tokensOut * 0.0015) / 10;

  return {
    faqs,
    tokens_in:  tokensIn,
    tokens_out: tokensOut,
    cost_cents: costCents,
    model:      GENERATOR_MODEL,
    rejected,
  };
}
