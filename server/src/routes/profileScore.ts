/* POST /agents/:slug/profile-score — customer-facing AI citation score.
 *
 * Runs the format-judge harness against the calling tenant's own profile
 * (read from D1) using a small, fast configuration: 1 query × 4 HTML
 * variants × 1 judge = 4 trials. Returns the score + per-variant
 * reasoning + an actionable "improvements" list mapped from the judge's
 * deductions to specific profile fields the tenant can edit.
 *
 * Auth: same Bearer api_key the worker already uses for other
 * /agents/:slug/* customer routes. Customer-only — admin-bearer
 * authority is also accepted by requireSlugOrAdminKey for ops-side
 * runs against any tenant.
 *
 * Why a separate endpoint rather than re-exposing /admin/experiments:
 *   - The admin endpoint is intentionally privileged (full control over
 *     judges, profile patches, batch sizes). Exposing it to customers
 *     would let a malicious tenant probe the harness against other
 *     slugs or run up arbitrary cost.
 *   - Customer-facing scores want a fixed config: one bot family at
 *     a time, one query, one judge model. Predictable cost per call
 *     (~$0.04), predictable shape, predictable runtime (~30s).
 *
 * Cost: ~$0.04 per call (4 trials × ~$0.01 each). Cap to one call
 * per tenant per ~5 minutes via per-slug rate limiter (TODO: wire to
 * existing TokenBucket). For now we accept the cost — early-tenant
 * volume is low and the scoring is the upsell hook so we want it run.
 */

import { Router, type Request, type Response } from "express";
import { runExperiment } from "../experiments/formatJudge/runner.js";
import { requireSlugOrAdminKey } from "../middleware/auth.js";

export const profileScoreRouter = Router();

/* The default query is generic so the score reflects "what AI would
 * say about you for a brand-direct lookup." Customers can override by
 * passing { query } in the body, but for the v0 score-my-profile
 * button we don't surface that — keeps the scoring comparable across
 * tenants and across re-runs. */
const DEFAULT_QUERY = (slug: string, name: string) =>
  `tell me about ${name || slug}`;

interface ImprovementSuggestion {
  field: string;
  reason: string;
  expected_lift: number;
  href: string;
}

/* Map the judge's most common deduction patterns to specific profile
 * fields the tenant can edit. Pattern matched as substring against the
 * `reasoning` text from each trial. Order matters — first match wins
 * per trial so a single trial returns one improvement, not many.
 *
 * Tuned against the deduction strings the format-judge harness saw in
 * iter1-12. As new patterns emerge from real customer runs, add
 * entries here — the deduction → action map is the actionable
 * intelligence we extract from the harness. */
const IMPROVEMENT_PATTERNS: Array<{
  test: RegExp;
  build: (slug: string) => ImprovementSuggestion;
}> = [
  {
    test: /third[- ]?party verification|self[- ]?reported (?:rating|review)|no (?:independent )?verification/i,
    build: (slug) => ({
      field: "ratings_json",
      reason: "Add your real Google / Yelp / Facebook / BBB review URLs. AI search engines treat platform-named ratings as third-party verification — measured +1 point per platform in our internal harness.",
      expected_lift: 1.5,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}#form-ratings`,
    }),
  },
  {
    test: /customer quotes|review snippets|customer (?:reviews|testimonial)/i,
    build: (slug) => ({
      field: "customer_quotes_json",
      reason: "Add 2-3 real customer quotes with author names. Each quote becomes a schema.org Review entry — extractors weight named-author reviews higher than aggregate ratings alone.",
      expected_lift: 1.0,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}#form-quotes`,
    }),
  },
  {
    test: /credentials|licenses|certifications/i,
    build: (slug) => ({
      field: "credentials_json",
      reason: "Add licenses, certifications, or industry credentials. AI engines surface these as authority signals; verify-hint URLs are even better.",
      expected_lift: 0.5,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}`,
    }),
  },
  {
    test: /no (?:json[- ]?ld|schema\.org|structured data)/i,
    build: (slug) => ({
      field: "_internal",
      reason: "This variant doesn't emit schema.org JSON-LD by design. Use the per-bot HTML variants instead — they all include rich JSON-LD which lifts citation rate substantially.",
      expected_lift: 2.0,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}`,
    }),
  },
  {
    test: /generic|unspecific|category words/i,
    build: (slug) => ({
      field: "differentiator",
      reason: "Tighten your differentiator and top services with concrete, specific words (e.g. 'Klaviyo email flows for DTC ecommerce' beats 'email marketing services').",
      expected_lift: 0.5,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}#form-positioning`,
    }),
  },
  {
    test: /pricing|cost transparency/i,
    build: (slug) => ({
      field: "pricing_json_v2",
      reason: "Add pricing ranges in Operations → Pricing. Transparent pricing builds trust signals AI search engines reward.",
      expected_lift: 0.5,
      href: `/BusinessProfile.html${slug ? `?as=${encodeURIComponent(slug)}` : ""}`,
    }),
  },
];

function buildImprovements(
  trials: Array<{ variant_id: string; reasoning: string; citability_score: number }>,
  slug: string,
): ImprovementSuggestion[] {
  const seen = new Set<string>();
  const out: ImprovementSuggestion[] = [];

  // Skim the worst-performing trials first — those are the deductions
  // a customer can fix with the most upside.
  const sorted = [...trials].sort((a, b) => a.citability_score - b.citability_score);

  for (const t of sorted) {
    for (const pat of IMPROVEMENT_PATTERNS) {
      if (pat.test.test(t.reasoning)) {
        const sug = pat.build(slug);
        if (!seen.has(sug.field)) {
          seen.add(sug.field);
          out.push(sug);
          break;  // one suggestion per trial; move to next trial
        }
      }
    }
  }

  return out.slice(0, 4);
}

profileScoreRouter.post(
  "/agents/:slug/profile-score",
  requireSlugOrAdminKey,
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const body = (req.body ?? {}) as { query?: unknown };
    const query =
      typeof body.query === "string" && body.query.trim().length > 0
        ? body.query.trim().slice(0, 200)
        : DEFAULT_QUERY(slug, slug);

    try {
      const result = await runExperiment({
        profileSlugs: [slug],
        queries: [query],
        // Score the per-bot HTML variants only — control_json + plain
        // markdown are reference baselines, not customer-actionable.
        variantIds: ["perplexity_html", "openai_html", "claude_html", "google_html"],
      });

      // Customer-facing summary. Score is the AVG across the 4 variants
      // (one per bot family). Per-variant scores are surfaced separately
      // so we can show which AIs love this profile and which don't.
      const variantScores = result.summary.map((s) => ({
        variant_id: s.variant_id,
        score:      s.mean_citability,
        cite_rate:  s.cite_rate,
      }));
      const avgScore =
        variantScores.reduce((a, v) => a + v.score, 0) /
        Math.max(1, variantScores.length);

      const improvements = buildImprovements(
        result.trials.map((t) => ({
          variant_id: t.variant_id,
          reasoning: t.reasoning,
          citability_score: t.citability_score,
        })),
        slug,
      );

      res.json({
        slug,
        query,
        score: Number(avgScore.toFixed(2)),
        score_max: 10,
        cite_rate: Math.round(
          (variantScores.reduce((a, v) => a + v.cite_rate, 0) /
            Math.max(1, variantScores.length)) * 100,
        ),
        per_variant: variantScores,
        improvements,
        sample_reasoning: result.trials[0]?.reasoning ?? "",
        run_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[profile-score] ${slug} failed:`, err);
      res.status(500).json({
        error: "score_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
