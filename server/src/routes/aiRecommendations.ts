/* /agents/:slug/ai-recommendations — Pro/Enterprise AI Insights surface.
 *
 * Builds a tenant-tailored set of 6-10 ranked recommendations by sending
 * the tenant's full data context (profile, citation score breakdown,
 * last-30d bot traffic, competitor radar) to Claude. Output is validated
 * by zod and cached for 7 days, keyed by composite hash so any change
 * to profile / score / analytics window auto-invalidates.
 *
 * This is the AI-driven counterpart to the regex-pattern
 * `buildImprovements` already in profileScore.ts:261. Both surfaces
 * remain — Base/Free tenants see the regex output (legacy
 * "TOP OPPORTUNITIES TO IMPROVE"), Pro/Enterprise tenants see the new
 * AI Insights panel below it.
 *
 * Endpoints:
 *   GET  /agents/:slug/ai-recommendations
 *     Cache-only read. Never spends API budget. Returns is_stale=true
 *     when the composite hash mismatches OR generated_at is older than
 *     7 days.
 *
 *   POST /agents/:slug/ai-recommendations  body: { force?: boolean }
 *     Plan-gated (402 plan_required for Base/Free). On cache miss or
 *     force=true: rate-limit gate → dual budget reserve → context bundle
 *     → Claude call (with prompt cache) → schema-validate → persist.
 *
 * Cost: ~$0.05-0.10 per fresh run (Claude Sonnet, 3-5k input + 1-2k
 * output, ephemeral cache on system block). Reservation $0.20 (2x
 * headroom). Per-tenant daily cap $2 inherited from tenantBudget.
 *
 * Failure-mode contract: Claude can return malformed JSON. The endpoint
 * never 5xxs on parse failure — it returns a single fallback card with
 * status 200 so the UI degrades gracefully. Sentry captures the parse
 * failure for ops triage.
 */

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getDb } from "../db.js";
import type { BusinessRow } from "../db.js";
import { requireServerKeyOnly } from "../middleware/auth.js";
import { checkLimit } from "../middleware/costRateLimit.js";
import {
  reserve as budgetReserve,
  record as budgetRecord,
  release as budgetRelease,
} from "../middleware/budgetKillSwitch.js";
import {
  reserveForSlug,
  recordForSlug,
  releaseForSlug,
} from "../middleware/tenantBudget.js";
import { computeCostCents } from "../agent/taxonomy.js";

export const aiRecommendationsRouter = Router();

// ── Anthropic client ────────────────────────────────────────────────────────
//
// Singleton Anthropic instance. Mirrors the pattern in agent/query.ts:16 so
// the same global rate-limit + retry behavior applies. apiKey resolution is
// lazy at first call so tests can mock the SDK without needing a real env
// var present at module-load time.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

// ── Constants ────────────────────────────────────────────────────────────────

const STALE_AFTER_MS  = 7 * 24 * 60 * 60_000; // 7 days
const RESERVATION_USD = 0.20;                  // 2x headroom over typical $0.05-0.10 actual

/* Two-tier per-slug rate limit. Cache hits skip both limits entirely
 * (we only checkLimit() on the fresh-run path). */
const AI_RECS_LIMITS = [
  { label: "ai-recs:burst", cfg: { max: 3,  windowMs: 60_000 } },
  { label: "ai-recs:daily", cfg: { max: 20, windowMs: 24 * 60 * 60_000 } },
];

const RECS_MIN = 6;
const RECS_MAX = 10;

// ── Type contracts ───────────────────────────────────────────────────────────

const PRIORITIES = ["high", "med", "low"] as const;

const AIRecommendationSchema = z.object({
  id:                    z.string().min(1).max(64),
  title:                 z.string().min(1).max(120),
  body:                  z.string().min(1).max(600),
  priority:              z.enum(PRIORITIES),
  impact:                z.string().min(1).max(200),
  action_label:          z.string().max(80).optional(),
  action_url:            z.string().max(200).optional(),
  expected_score_delta:  z.number().min(0).max(2).optional(),
  related_field:         z.string().max(80).optional(),
});

const RecommendationsPayloadSchema = z.object({
  recommendations: z.array(AIRecommendationSchema).min(RECS_MIN).max(RECS_MAX),
});

export type AIRecommendation = z.infer<typeof AIRecommendationSchema>;

interface CachedAIRecs {
  profile_hash:        string;
  score_hash:          string;
  analytics_window_id: string;
  generated_at:        string;
  recommendations:     AIRecommendation[];
  model:               string;
  cost_cents:          number;
  trial_id:            string;
  /** "ok" or "fallback" — set to "fallback" when Claude returned malformed
   *  JSON and we substituted a placeholder card. Cached either way so we
   *  don't hammer Anthropic on a bad-prompt loop. */
  outcome:             "ok" | "fallback";
}

// ── Hash helpers ────────────────────────────────────────────────────────────

/* Profile hash — REUSES the same field set as profileScore.ts so a tenant
 * edit invalidates BOTH score and ai-recs caches in lockstep. Importing
 * the const from profileScore.ts would create a circular module shape
 * (this route is mounted alongside profileScoreRouter); duplicating the
 * 27-element array is the lesser evil. Sync rule: if HASH_FIELDS changes
 * in profileScore.ts, change here too. */
const HASH_FIELDS = [
  "name", "description", "services", "category", "location", "phone",
  "website", "referral_url", "tone", "star_rating", "review_count",
  "years_in_business", "top_services", "availability", "differentiator",
  "service_radius_miles", "certifications", "pricing_tier",
  "service_area_keywords",
  "hours_json", "pricing_json_v2",
  "ratings_json", "customer_quotes_json", "credentials_json",
  "case_stories_json", "differentiators_text", "guarantee_text",
] as const;

function computeProfileHash(business: Partial<BusinessRow>): string {
  const subset: Record<string, unknown> = {};
  for (const k of HASH_FIELDS) {
    subset[k] = (business as unknown as Record<string, unknown>)[k] ?? null;
  }
  const stable = JSON.stringify(
    Object.keys(subset).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = subset[k];
      return acc;
    }, {}),
  );
  return "sha256:" + crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function computeScoreHash(scoreBlob: string | null | undefined): string {
  if (!scoreBlob) return "sha256:no-score";
  // Hash the per_variant + run_at fields specifically — the rest of the
  // CachedScore blob (improvements, sample_reasoning) doesn't materially
  // change the recommendations.
  try {
    const parsed = JSON.parse(scoreBlob) as { per_variant?: unknown; run_at?: string };
    const subset = JSON.stringify({
      per_variant: parsed.per_variant ?? null,
      run_at:      parsed.run_at ?? null,
    });
    return "sha256:" + crypto.createHash("sha256").update(subset).digest("hex").slice(0, 32);
  } catch {
    return "sha256:bad-score-blob";
  }
}

/* Analytics window id rolls every 24 hours so cache stays fresh against
 * the rolling 30-day window. We use a UTC date-key (YYYY-MM-DD) hashed
 * so two tenants reading on the same day share the rollover but two
 * different days produce different ids → triggers fresh recs. */
function computeAnalyticsWindowId(now: Date = new Date()): string {
  const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD UTC
  return "sha256:" + crypto.createHash("sha256").update(dateKey).digest("hex").slice(0, 16);
}

// ── Cache I/O ────────────────────────────────────────────────────────────────

function readRecsCache(business: BusinessRow): CachedAIRecs | null {
  if (!business.last_ai_recommendations_json) return null;
  try {
    const parsed = JSON.parse(business.last_ai_recommendations_json) as CachedAIRecs;
    if (
      typeof parsed.profile_hash === "string" &&
      typeof parsed.score_hash === "string" &&
      Array.isArray(parsed.recommendations)
    ) {
      return parsed;
    }
  } catch { /* malformed → treat as no cache */ }
  return null;
}

function writeRecsCache(slug: string, blob: CachedAIRecs): void {
  const db = getDb();
  db.prepare(
    `UPDATE businesses SET last_ai_recommendations_json = ? WHERE slug = ?`,
  ).run(JSON.stringify(blob), slug);
}

function isCacheStale(cached: CachedAIRecs, now: Date = new Date()): boolean {
  const generatedAt = Date.parse(cached.generated_at);
  if (!Number.isFinite(generatedAt)) return true;
  return now.getTime() - generatedAt > STALE_AFTER_MS;
}

// ── Context bundle ──────────────────────────────────────────────────────────

interface ContextBundle {
  profile:        BusinessRow;
  score:          { score: number; cite_rate: number; per_variant: Array<{ variant_id: string; score: number; cite_rate: number }>; sample_reasoning: string } | null;
  analytics30d:   { total_queries: number; queries_by_crawler: Record<string, number>; queries_by_intent: Record<string, number>; top_queries: Array<{ query_text: string; count: number }> };
  radarSummary:   { total: number; cited: number; cite_rate: number; top_winning_competitors: Array<{ domain: string; cited_count: number }> };
}

function buildContextBundle(biz: BusinessRow): ContextBundle {
  const db = getDb();

  // Score from cached blob (no Anthropic call). Tolerate missing /
  // malformed; the prompt handles a null score gracefully.
  let score: ContextBundle["score"] = null;
  if (biz.last_score_json) {
    try {
      const parsed = JSON.parse(biz.last_score_json) as ContextBundle["score"];
      if (parsed && typeof parsed.score === "number") {
        score = parsed;
      }
    } catch { /* fall through */ }
  }

  // 30-day analytics window. Same shape as analytics.ts/156 but inline
  // here to avoid a sub-fetch round trip.
  const SINCE = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const total = (db.prepare(
    "SELECT COUNT(*) AS c FROM queries WHERE business_slug = ? AND timestamp >= ?",
  ).get(biz.slug, SINCE) as { c: number }).c;

  const byCrawlerRows = db.prepare(
    `SELECT crawler_agent AS k, COUNT(*) AS c
       FROM queries
      WHERE business_slug = ? AND timestamp >= ?
      GROUP BY crawler_agent
      ORDER BY c DESC
      LIMIT 12`,
  ).all(biz.slug, SINCE) as Array<{ k: string | null; c: number }>;
  const queries_by_crawler: Record<string, number> = {};
  for (const r of byCrawlerRows) {
    if (r.k) queries_by_crawler[r.k] = r.c;
  }

  const byIntentRows = db.prepare(
    `SELECT intent AS k, COUNT(*) AS c
       FROM queries
      WHERE business_slug = ? AND timestamp >= ? AND intent IS NOT NULL
      GROUP BY intent
      ORDER BY c DESC
      LIMIT 12`,
  ).all(biz.slug, SINCE) as Array<{ k: string | null; c: number }>;
  const queries_by_intent: Record<string, number> = {};
  for (const r of byIntentRows) {
    if (r.k) queries_by_intent[r.k] = r.c;
  }

  const topQRows = db.prepare(
    `SELECT query_text, COUNT(*) AS c
       FROM queries
      WHERE business_slug = ? AND timestamp >= ? AND query_text IS NOT NULL
      GROUP BY query_text
      ORDER BY c DESC
      LIMIT 8`,
  ).all(biz.slug, SINCE) as Array<{ query_text: string; c: number }>;
  const top_queries = topQRows.map((r) => ({ query_text: r.query_text, count: r.c }));

  // Competitor radar summary — tolerate missing tables (older deploys
  // pre-migration 013 had no competitor_polls).
  let radarSummary: ContextBundle["radarSummary"] = {
    total: 0, cited: 0, cite_rate: 0, top_winning_competitors: [],
  };
  try {
    const polls = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN our_domain_cited=1 THEN 1 ELSE 0 END) AS cited
         FROM competitor_polls
        WHERE slug = ? AND polled_at >= ?`,
    ).get(biz.slug, SINCE) as { total: number; cited: number | null };
    const top = db.prepare(
      `SELECT cc.domain, COUNT(*) AS cited_count
         FROM competitor_citations cc
         JOIN competitor_polls cp ON cp.id = cc.poll_id
        WHERE cp.slug = ? AND cp.polled_at >= ? AND cp.our_domain_cited = 0
        GROUP BY cc.domain
        ORDER BY cited_count DESC
        LIMIT 5`,
    ).all(biz.slug, SINCE) as Array<{ domain: string; cited_count: number }>;
    const cited = polls.cited ?? 0;
    radarSummary = {
      total: polls.total ?? 0,
      cited,
      cite_rate: polls.total > 0 ? cited / polls.total : 0,
      top_winning_competitors: top,
    };
  } catch { /* radar tables missing → leave summary zeroed */ }

  return {
    profile:      biz,
    score,
    analytics30d: { total_queries: total, queries_by_crawler, queries_by_intent, top_queries },
    radarSummary,
  };
}

// ── Prompt construction ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a marketing analyst for AdvocateMCP, an AI-search-visibility platform that helps small businesses get cited by AI search engines (ChatGPT, Perplexity, Claude, Gemini, Copilot).

Your job: produce 6-10 ranked, specific recommendations to improve a tenant's citation readiness. You ONLY recommend actions the tenant can take inside their AdvocateMCP dashboard (edit their profile fields, add ratings, set hours, generate FAQs). You ALWAYS reference tenant-specific data — their per-engine score variants, their actual bot traffic patterns, their competitor citations. You NEVER produce generic advice that would apply to any tenant.

Your output is STRICT JSON matching this schema (no prose, no markdown):
{
  "recommendations": [
    {
      "id":                   string  // 8-32 chars, stable hash for dedup
      "title":                string  // ≤ 12 words, action-oriented
      "body":                 string  // 1-3 sentences referencing tenant specifics
      "priority":             "high" | "med" | "low"
      "impact":               string  // one phrase: "Lifts X by Y" or "Captures Z intent"
      "action_label":         string  // optional, e.g. "Open Pricing", "Edit FAQs"
      "action_url":           string  // optional, e.g. "/BusinessProfile?focus=pricing"
      "expected_score_delta": number  // optional, 0.1-1.5 range, your best estimate of /10 lift
      "related_field":        string  // optional, profile field key like "ratings_json"
    },
    ...
  ]
}

Sort recommendations by priority (high first) then expected_score_delta desc. Provide exactly 6-10 entries. Output ONLY the JSON object — no leading text, no code fences.`;

function buildUserPrompt(bundle: ContextBundle): string {
  const profile = {
    name:                  bundle.profile.name,
    description:           bundle.profile.description,
    category:              bundle.profile.category,
    services:              bundle.profile.services,
    location:              bundle.profile.location,
    star_rating:           bundle.profile.star_rating,
    review_count:          bundle.profile.review_count,
    years_in_business:     bundle.profile.years_in_business,
    top_services:          bundle.profile.top_services,
    differentiator:        bundle.profile.differentiator,
    differentiators_text:  bundle.profile.differentiators_text,
    pricing_tier:          bundle.profile.pricing_tier,
    pricing_json_v2:       parseJsonOrNull(bundle.profile.pricing_json_v2),
    hours_json:            parseJsonOrNull(bundle.profile.hours_json),
    ratings_json:          parseJsonOrNull(bundle.profile.ratings_json),
    customer_quotes_json:  parseJsonOrNull(bundle.profile.customer_quotes_json),
    credentials_json:      parseJsonOrNull(bundle.profile.credentials_json),
    case_stories_json:     parseJsonOrNull(bundle.profile.case_stories_json),
    guarantee_text:        bundle.profile.guarantee_text,
    certifications:        bundle.profile.certifications,
    service_area_keywords: bundle.profile.service_area_keywords,
  };

  return `<tenant_profile>
${JSON.stringify(profile, null, 2)}
</tenant_profile>

<citation_score>
${bundle.score
  ? JSON.stringify({
      overall:           bundle.score.score,
      cite_rate:         bundle.score.cite_rate,
      per_variant:       bundle.score.per_variant,
      sample_reasoning:  bundle.score.sample_reasoning?.slice(0, 1500) ?? "",
    }, null, 2)
  : "null (no score yet — recommend running citation check first)"}
</citation_score>

<bot_traffic_30d>
${JSON.stringify(bundle.analytics30d, null, 2)}
</bot_traffic_30d>

<competitor_radar>
${JSON.stringify(bundle.radarSummary, null, 2)}
</competitor_radar>

Produce 6-10 ranked recommendations as STRICT JSON per the schema. Reference the tenant's specifics in every recommendation body — never generic advice.`;
}

function parseJsonOrNull(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Claude call ─────────────────────────────────────────────────────────────

interface ClaudeCallResult {
  text:        string;
  usage:       { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  model:       string;
  cost_cents:  number;
}

async function callClaudeForRecs(userPrompt: string): Promise<ClaudeCallResult> {
  const model = process.env.MODEL ?? "claude-sonnet-4-6";
  const message = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }, // 5min ephemeral prompt cache
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const tokensIn  = message.usage?.input_tokens  ?? 0;
  const tokensOut = message.usage?.output_tokens ?? 0;
  const costCents = computeCostCents(model, tokensIn, tokensOut);

  return {
    text,
    usage: {
      input_tokens:  tokensIn,
      output_tokens: tokensOut,
      cache_creation_input_tokens: (message.usage as unknown as { cache_creation_input_tokens?: number })?.cache_creation_input_tokens,
      cache_read_input_tokens:     (message.usage as unknown as { cache_read_input_tokens?: number })?.cache_read_input_tokens,
    },
    model,
    cost_cents: costCents,
  };
}

// ── Validation + parsing ────────────────────────────────────────────────────

function parseAndValidate(text: string): AIRecommendation[] {
  // Claude sometimes wraps JSON in ```json fences despite the system
  // prompt. Strip a leading code-fence if present, then parse.
  let body = text.trim();
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) body = fenceMatch[1];

  const parsed = JSON.parse(body) as unknown;          // may throw
  const valid = RecommendationsPayloadSchema.parse(parsed); // may throw
  return valid.recommendations;
}

function fallbackCard(reason: "validation" | "error" | "no_score" | "anthropic_unavailable"): AIRecommendation[] {
  const messages: Record<typeof reason, { title: string; body: string; impact: string }> = {
    validation: {
      title:  "AI insights temporarily unavailable",
      body:   "We received a response from our AI but couldn't validate it cleanly. The team has been notified. Try regenerating in a few minutes — most cases self-heal.",
      impact: "Try again shortly",
    },
    error: {
      title:  "AI insights temporarily unavailable",
      body:   "We hit an unexpected error generating your recommendations. The team has been notified. Try regenerating in a few minutes.",
      impact: "Try again shortly",
    },
    no_score: {
      title:  "Run your first citation check",
      body:   "AI Insights work best after you've run at least one citation rating check — we use the per-engine breakdown to pinpoint where to invest. Click 'Run citation check' on this page to seed the data.",
      impact: "Unblocks tenant-tailored insights",
    },
    anthropic_unavailable: {
      title:  "AI service temporarily unavailable",
      body:   "Our AI provider is having issues right now. We've fallen back to the regex-based opportunities above. Retry once Anthropic status is green.",
      impact: "Try again shortly",
    },
  };
  const m = messages[reason];
  return [
    {
      id:       `fallback-${reason}`,
      title:    m.title,
      body:     m.body,
      priority: "low",
      impact:   m.impact,
    },
  ];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadBusiness(slug: string): BusinessRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM businesses WHERE slug = ?").get(slug) as BusinessRow | undefined;
  return row ?? null;
}

function buildCachedBlob(args: {
  recommendations: AIRecommendation[];
  profileHash:     string;
  scoreHash:       string;
  windowId:        string;
  model:           string;
  costCents:       number;
  outcome:         CachedAIRecs["outcome"];
}): CachedAIRecs {
  return {
    profile_hash:        args.profileHash,
    score_hash:          args.scoreHash,
    analytics_window_id: args.windowId,
    generated_at:        new Date().toISOString(),
    recommendations:     args.recommendations,
    model:               args.model,
    cost_cents:          args.costCents,
    trial_id:            crypto.randomUUID(),
    outcome:             args.outcome,
  };
}

// ── GET /agents/:slug/ai-recommendations ────────────────────────────────────
//
// Cache-only fast read. Never spends API budget. Returns is_stale=true
// when ANY of (profile_hash, score_hash, analytics_window_id) doesn't
// match current OR generated_at older than 7d. Frontend uses is_stale to
// decide whether to auto-regenerate.

aiRecommendationsRouter.get(
  "/agents/:slug/ai-recommendations",
  requireServerKeyOnly,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const biz = loadBusiness(slug);
    if (!biz) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const cached = readRecsCache(biz);
    if (!cached) {
      res.json({ slug, has_recommendations: false, is_stale: true, recommendations: [] });
      return;
    }

    const currentProfileHash = computeProfileHash(biz);
    const currentScoreHash   = computeScoreHash(biz.last_score_json);
    const currentWindowId    = computeAnalyticsWindowId();
    const hashMismatch =
      cached.profile_hash        !== currentProfileHash ||
      cached.score_hash          !== currentScoreHash   ||
      cached.analytics_window_id !== currentWindowId;
    const stale = hashMismatch || isCacheStale(cached);

    res.json({
      slug,
      has_recommendations: true,
      is_stale:            stale,
      generated_at:        cached.generated_at,
      recommendations:     cached.recommendations,
      outcome:             cached.outcome,
      model:               cached.model,
    });
  },
);

// ── POST /agents/:slug/ai-recommendations ───────────────────────────────────
//
// Plan-gated fresh-run path. Returns 200 with cached blob on cache hit
// (unless body.force=true). Otherwise: rate-limit gate → dual budget
// reserve → context bundle → Claude call → validate → persist.

aiRecommendationsRouter.post(
  "/agents/:slug/ai-recommendations",
  requireServerKeyOnly,
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const body = (req.body ?? {}) as { force?: unknown };
    const force = body.force === true;

    const biz = loadBusiness(slug);
    if (!biz) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Plan check inline. Pro/Enterprise only — Base/Free see the regex-
    // based "TOP OPPORTUNITIES" block instead. Mirror agent.ts:801-814.
    const plan = biz.plan ?? "base";
    if (plan !== "pro" && plan !== "enterprise") {
      res.status(402).json({
        error:   "plan_required",
        message: "AI Insights is a Pro feature. Upgrade to enable.",
        plan,
      });
      return;
    }

    const currentProfileHash = computeProfileHash(biz);
    const currentScoreHash   = computeScoreHash(biz.last_score_json);
    const currentWindowId    = computeAnalyticsWindowId();

    // Cache hit — return immediately, no budget spend.
    const cached = readRecsCache(biz);
    if (
      !force &&
      cached &&
      cached.profile_hash        === currentProfileHash &&
      cached.score_hash          === currentScoreHash   &&
      cached.analytics_window_id === currentWindowId    &&
      !isCacheStale(cached)
    ) {
      res.json({
        slug,
        has_recommendations: true,
        is_stale:            false,
        cache_hit:           true,
        ...cached,
      });
      return;
    }

    // Cache miss — gate spend.
    const gate = checkLimit({ key: slug, limits: AI_RECS_LIMITS });
    if (!gate.allowed) {
      const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error:               "rate_limited",
        message:             `Too many fresh runs for ${slug} (${gate.label}). Try again in ${retryAfterSec}s.`,
        retry_after_seconds: retryAfterSec,
      });
      return;
    }

    const tenantBudget = reserveForSlug(slug, RESERVATION_USD);
    if (!tenantBudget.allowed) {
      res.status(503).json({
        error:         "tenant_budget_exhausted",
        message:       `Per-tenant daily AI budget exhausted for ${slug} ($${tenantBudget.capUsd.toFixed(2)} cap, $${tenantBudget.remainingUsd.toFixed(2)} left). Try again after UTC midnight or contact support.`,
        remaining_usd: tenantBudget.remainingUsd,
        cap_usd:       tenantBudget.capUsd,
        scope:         "tenant",
      });
      return;
    }
    const budget = budgetReserve(RESERVATION_USD);
    if (!budget.allowed) {
      releaseForSlug(slug, RESERVATION_USD);
      res.status(503).json({
        error:         "budget_exhausted",
        message:       `Daily AI budget exhausted ($${budget.capUsd.toFixed(2)} cap, $${budget.remainingUsd.toFixed(2)} left). Try again after UTC midnight.`,
        remaining_usd: budget.remainingUsd,
        cap_usd:       budget.capUsd,
        scope:         "global",
      });
      return;
    }

    // Spend the budget on a real run.
    let recommendations: AIRecommendation[];
    let model     = process.env.MODEL ?? "claude-sonnet-4-6";
    let costCents = 0;
    let outcome: CachedAIRecs["outcome"] = "ok";

    try {
      const bundle      = buildContextBundle(biz);
      const userPrompt  = buildUserPrompt(bundle);
      const claudeRes   = await callClaudeForRecs(userPrompt);
      model     = claudeRes.model;
      costCents = claudeRes.cost_cents;

      try {
        recommendations = parseAndValidate(claudeRes.text);
      } catch (parseErr) {
        console.warn(JSON.stringify({
          ai_recs:      true,
          event:        "validation_failed",
          slug,
          error:        parseErr instanceof Error ? parseErr.message : String(parseErr),
          raw_preview:  claudeRes.text.slice(0, 500),
        }));
        recommendations = fallbackCard("validation");
        outcome = "fallback";
      }
    } catch (err) {
      // Anthropic call itself blew up. Release reservations + return
      // fallback (200, not 500) so the UI degrades cleanly.
      budgetRelease(RESERVATION_USD);
      releaseForSlug(slug, RESERVATION_USD);
      console.error(JSON.stringify({
        ai_recs: true,
        event:   "claude_call_failed",
        slug,
        error:   err instanceof Error ? err.message : String(err),
      }));
      const fallback = fallbackCard("anthropic_unavailable");
      const blob = buildCachedBlob({
        recommendations: fallback,
        profileHash:     currentProfileHash,
        scoreHash:       currentScoreHash,
        windowId:        currentWindowId,
        model,
        costCents:       0,
        outcome:         "fallback",
      });
      // Don't persist a fallback as the cached value — let the next call
      // try fresh. (Cache misses are cheap; persistent fallback is worse
      // UX than a brief retry window.)
      res.json({ slug, has_recommendations: true, is_stale: false, cache_hit: false, ...blob });
      return;
    }

    // Persist + record actual spend.
    const blob = buildCachedBlob({
      recommendations,
      profileHash: currentProfileHash,
      scoreHash:   currentScoreHash,
      windowId:    currentWindowId,
      model,
      costCents,
      outcome,
    });
    if (outcome === "ok") {
      // Only cache valid runs — fallback cards aren't worth re-serving.
      writeRecsCache(slug, blob);
    } else {
      // Validation fallback — release the reservation since we're not
      // counting this as a useful spend (Claude charged us; we just
      // don't cache it). Record the actual cost to global budget so the
      // kill-switch sees real usage.
    }
    budgetRecord(RESERVATION_USD, costCents / 100);
    recordForSlug(slug, RESERVATION_USD, costCents / 100);

    res.json({
      slug,
      has_recommendations: true,
      is_stale:            false,
      cache_hit:           false,
      ...blob,
    });
  },
);
