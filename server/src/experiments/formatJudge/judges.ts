/* Judge models: invoke Claude (and optionally OpenAI/Gemini) to score
 * a rendered format variant against a user query.
 *
 * Each judge gets:
 *   - The user's query (representing what an AI search engine is
 *     trying to answer)
 *   - The rendered format variant (HTML / JSON / markdown)
 *   - A scoring rubric
 *
 * Returns a 1-10 citability score + free-text reasoning + a binary
 * "would_cite" decision.
 *
 * Why use frontier models as judges: they're trained on the same web
 * corpora that production crawlers (GPTBot, ClaudeBot, etc.) ingest.
 * Their "would I cite this?" judgment correlates with — but does not
 * perfectly equal — the production extractor's behavior. Triangulate
 * with real-world citation data when available. */

import Anthropic from "@anthropic-ai/sdk";
import type { JudgeTrial } from "./types.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/** Anthropic Sonnet pricing (April 2026): $3/Mtok input, $15/Mtok output. */
const SONNET_INPUT_PER_TOK  = 3 / 1_000_000;
const SONNET_OUTPUT_PER_TOK = 15 / 1_000_000;

/** Anthropic Haiku pricing: $0.80/Mtok input, $4/Mtok output. */
const HAIKU_INPUT_PER_TOK   = 0.80 / 1_000_000;
const HAIKU_OUTPUT_PER_TOK  = 4 / 1_000_000;

function priceFor(model: string, inTok: number, outTok: number): number {
  if (model.includes("haiku")) {
    return inTok * HAIKU_INPUT_PER_TOK + outTok * HAIKU_OUTPUT_PER_TOK;
  }
  return inTok * SONNET_INPUT_PER_TOK + outTok * SONNET_OUTPUT_PER_TOK;
}

const SYSTEM_PROMPT = `You are evaluating a webpage's quality as a citation source for an AI search engine.

You are NOT a content marketer. You are simulating how an AI search engine's extraction pipeline (Google AI Overview, Perplexity, ChatGPT search, Claude search) would assess this content as a candidate citation source.

For each evaluation, output exactly this JSON shape and nothing else:

{
  "citability_score": <integer 1-10>,
  "would_cite": <boolean>,
  "reasoning": "<2-3 sentences explaining your score>"
}

Scoring rubric:
- 10: ideal. Schema.org JSON-LD present and complete. Clear lead sentence. Self-contained citable claims. Trust signals. Action-oriented CTA. Would definitely cite.
- 7-9: strong. Most extraction signals present, minor gaps.
- 4-6: workable but weak. Either the prose is good but structure is missing, or vice versa. Citation likely only if alternatives are worse.
- 1-3: poor. Hard to extract entity/facts cleanly, or mostly marketing fluff.

Penalize:
- Over-confident claims without attribution
- Marketing hype words ("amazing", "best in class", "world-class")
- AI-disclaimer hedges ("I'm an AI", "based on available info")
- Missing structured data when the format type implies it (e.g. an HTML page with no JSON-LD)
- JSON envelopes wrapping markdown when HTML would be more parseable
- Bullet pages where the bullets aren't self-contained (rely on pronouns to a missing antecedent)

Reward:
- Clean schema.org JSON-LD (LocalBusiness, ProfessionalService, FAQPage, Speakable)
- Bold inline key facts (Perplexity-style)
- Self-reported attribution preserved ("reports", "states", "describes as")
- Action-specific CTA naming the verb (Book / Quote / Call / Visit)
- First sentence ≤160 chars containing entity + specialty + location

Be a tough but fair judge. Most pages should land 4-7. Reserve 9-10 for genuinely strong extraction targets.`;

export async function judgeFormat(args: {
  judgeModel: string;
  query: string;
  rendered: string;
  variantId: string;
  businessSlug: string;
}): Promise<JudgeTrial> {
  const { judgeModel, query, rendered, variantId, businessSlug } = args;

  const userPrompt = `Query the AI search engine is trying to answer:
"${query}"

Candidate citation source (rendered for evaluation):
---
${rendered}
---

Output the JSON only. No prose before or after.`;

  const t0 = Date.now();
  const message = await anthropic.messages.create({
    model: judgeModel,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  const latency = Date.now() - t0;

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = parseJudgeOutput(text);

  return {
    business_slug: businessSlug,
    query,
    variant_id: variantId,
    judge_model: judgeModel,
    citability_score: parsed.citability_score,
    reasoning: parsed.reasoning,
    would_cite: parsed.would_cite,
    input_tokens: message.usage?.input_tokens ?? 0,
    output_tokens: message.usage?.output_tokens ?? 0,
    latency_ms: latency,
  };
}

function parseJudgeOutput(raw: string): {
  citability_score: number;
  would_cite: boolean;
  reasoning: string;
} {
  // Find first {...} block. Tolerant of leading/trailing prose even
  // though we asked for JSON only.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) {
    return {
      citability_score: 0,
      would_cite: false,
      reasoning: `(parse failure) raw=${raw.slice(0, 200)}`,
    };
  }
  try {
    const obj = JSON.parse(m[0]) as Partial<{
      citability_score: number;
      would_cite: boolean;
      reasoning: string;
    }>;
    return {
      citability_score:
        typeof obj.citability_score === "number"
          ? Math.min(10, Math.max(1, Math.round(obj.citability_score)))
          : 0,
      would_cite: !!obj.would_cite,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
    };
  } catch (e) {
    return {
      citability_score: 0,
      would_cite: false,
      reasoning: `(json parse failure) raw=${raw.slice(0, 200)}`,
    };
  }
}

/** Cost for a single trial in USD. */
export function trialCost(t: JudgeTrial): number {
  return priceFor(t.judge_model, t.input_tokens, t.output_tokens);
}
