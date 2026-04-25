/* LLM-as-judge format experiment harness — shared types.
 *
 * The experiment answers "for this business profile + this query, which
 * presentation format would a frontier LLM most likely cite?" by:
 *   1. Rendering the profile in N format variants (HTML+JSON-LD per bot,
 *      plain JSON, plain markdown, etc.)
 *   2. Prompting one or more judge models to score each variant 1-10 on
 *      citability AND extract structured fields
 *   3. Aggregating across many (profile × query × variant × judge) cells
 *      to produce statistical rankings
 *
 * The output is a markdown report at experiments/format-judge-<ts>.md
 * plus a JSON dump for programmatic re-analysis.
 *
 * Why we trust this: the judge models (Claude Sonnet, optionally GPT-4)
 * are trained on the same corpora that produced the production crawler
 * extractors (GPTBot, ClaudeBot, etc.). The exact crawler may use a
 * cheaper / smaller model, but the *relative* ranking of formats should
 * correlate. Verify by triangulating with real-world citation data
 * (Tier 1 #2: citation source mining) when available. */

import type { BusinessRow } from "../../db.js";

/** A single format variant under test. */
export interface FormatVariant {
  /** Stable id for the variant (used as a column header in reports). */
  id: string;

  /** Human-readable label. */
  label: string;

  /** Which bot family this is optimized for, if any. */
  optimizedFor: "perplexity" | "openai" | "claude" | "google" | "control" | "default";

  /** Render a business profile + agent answer text into this format's
   *  presentation. Returns a single string the judge will see. */
  render: (input: RenderInput) => string;
}

export interface RenderInput {
  business: BusinessRow;
  /** The natural-language answer text from queryAgent (the "response"
   *  field of AgentQueryResult). Each variant wraps this differently. */
  answerText: string;
  /** The user query that produced answerText. Used for FAQPage schema
   *  and Q&A framing. */
  query: string;
  /** Where the variant should send the searcher (typically the tracked
   *  redirect URL or the bare website URL). */
  referralUrl: string;
}

/** A single (business × query × variant × judge) trial. */
export interface JudgeTrial {
  business_slug: string;
  query: string;
  variant_id: string;
  judge_model: string;
  /** 1-10 citability score. */
  citability_score: number;
  /** Free-text reasoning the judge gave. */
  reasoning: string;
  /** Whether the judge would actually use this source for the query. */
  would_cite: boolean;
  /** Token usage for cost tracking. */
  input_tokens: number;
  output_tokens: number;
  /** Wall-clock latency for the judge call. */
  latency_ms: number;
}

/** Aggregated results for one variant across all trials. */
export interface VariantSummary {
  variant_id: string;
  trial_count: number;
  mean_citability: number;
  stddev_citability: number;
  cite_rate: number;       // fraction where would_cite === true
  total_cost_usd: number;
}

/** Top-level experiment configuration. */
export interface ExperimentConfig {
  /** Profiles to render (use real profiles from D1 or synthetic ones). */
  profiles: BusinessRow[];
  /** Queries to test against each profile. */
  queries: string[];
  /** Format variants. */
  variants: FormatVariant[];
  /** Judge model identifiers (Anthropic API model strings). */
  judges: string[];
  /** Optional: pre-computed agent answer text per (slug × query). If
   *  absent, runner calls queryAgent itself. */
  answerCache?: Map<string, string>;
}
