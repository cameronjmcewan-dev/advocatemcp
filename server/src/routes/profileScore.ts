/* /agents/:slug/profile-score — customer-facing AI citation score
 * with profile-hash caching so the displayed score is always the
 * legit score of the info AI is currently being served.
 *
 * Architecture:
 *   - Hash the renderable profile fields (description, ratings_json,
 *     customer_quotes_json, top_services, …). Same profile → same
 *     hash → same JSON-LD + prose → same score.
 *   - Cache the score keyed by hash in businesses.last_score_json.
 *   - Profile mutation invalidates the cache naturally — next request
 *     sees a hash mismatch and runs fresh. No stale scores.
 *   - Score history (bounded N=30) lives in businesses.score_history_json
 *     so the Overview sparkline shows trend without re-running.
 *
 * Endpoints:
 *   GET  /agents/:slug/profile-score
 *     Returns the cached score INSTANTLY. If the cached profile_hash
 *     doesn't match the current profile, returns is_stale=true so the
 *     client can decide to trigger a fresh run.
 *
 *   POST /agents/:slug/profile-score   body: { force?: boolean }
 *     Hash-check + run. Cache hit → returns cached score (no API
 *     spend). Cache miss (or { force: true }) → runs the format-judge
 *     harness, stores the new score blob + appends to history, returns
 *     the fresh result.
 *
 * Cost: ~$0.04 per cache miss. Cache hits are free. Customer who saves
 * profile + reruns once = $0.04 per profile change. Customer who just
 * navigates back to the page sees instant score from cache.
 */

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { getDb } from "../db.js";
import { runExperiment } from "../experiments/formatJudge/runner.js";
import { requireSlugOrAdminKey } from "../middleware/auth.js";
import type { BusinessRow } from "../db.js";

export const profileScoreRouter = Router();

const HISTORY_CAP = 30;

/* Fields that influence rendering. ANY change to ANY of these means
 * the rendered HTML/prose changes, which means the score may change,
 * which means the cache is invalidated.
 *
 * Keep this in lockstep with the renderer (server/src/agent/builder.ts +
 * server/src/experiments/formatJudge/formats/*) — if a renderer starts
 * reading a new field, add it here so cache invalidation tracks the
 * actual data dependency. */
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

function computeProfileHash(business: BusinessRow): string {
  const subset: Record<string, unknown> = {};
  for (const k of HASH_FIELDS) {
    subset[k] = (business as unknown as Record<string, unknown>)[k] ?? null;
  }
  // Stable JSON: sorted keys + UTF-8 bytes. Same data always → same hash.
  const stable = JSON.stringify(
    Object.keys(subset)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = subset[k];
        return acc;
      }, {})
  );
  return "sha256:" + crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

interface CachedScore {
  score: number;
  score_max: number;
  cite_rate: number;
  per_variant: Array<{ variant_id: string; score: number; cite_rate: number }>;
  improvements: Array<{ field: string; reason: string; expected_lift: number; href: string }>;
  sample_reasoning: string;
  run_at: string;
  profile_hash: string;
}

interface HistoryEntry {
  score: number;
  cite_rate: number;
  run_at: string;
}

function readCache(business: BusinessRow): CachedScore | null {
  if (!business.last_score_json) return null;
  try {
    const parsed = JSON.parse(business.last_score_json) as CachedScore;
    if (typeof parsed.score === "number" && typeof parsed.profile_hash === "string") {
      return parsed;
    }
  } catch { /* malformed JSON → treat as no cache */ }
  return null;
}

function readHistory(business: BusinessRow): HistoryEntry[] {
  if (!business.score_history_json) return [];
  try {
    const parsed = JSON.parse(business.score_history_json);
    if (Array.isArray(parsed)) return parsed as HistoryEntry[];
  } catch { /* fall through */ }
  return [];
}

function writeCache(slug: string, blob: CachedScore, prevHistory: HistoryEntry[]): void {
  const db = getDb();
  // Append to history. Cap at HISTORY_CAP entries so the JSON column
  // stays bounded over time (30 weeks of history at one save per week).
  const newHistory: HistoryEntry[] = [
    ...prevHistory,
    { score: blob.score, cite_rate: blob.cite_rate, run_at: blob.run_at },
  ].slice(-HISTORY_CAP);
  db.prepare(
    `UPDATE businesses
       SET last_score_json = ?, score_history_json = ?
     WHERE slug = ?`
  ).run(JSON.stringify(blob), JSON.stringify(newHistory), slug);
}

const DEFAULT_QUERY = (slug: string, name: string) =>
  `tell me about ${name || slug}`;

interface ImprovementSuggestion {
  field: string;
  reason: string;
  expected_lift: number;
  href: string;
}

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
  const sorted = [...trials].sort((a, b) => a.citability_score - b.citability_score);
  for (const t of sorted) {
    for (const pat of IMPROVEMENT_PATTERNS) {
      if (pat.test.test(t.reasoning)) {
        const sug = pat.build(slug);
        if (!seen.has(sug.field)) {
          seen.add(sug.field);
          out.push(sug);
          break;
        }
      }
    }
  }
  return out.slice(0, 4);
}

/* GET /agents/:slug/profile-score
 * Fast cache-only read. Returns the cached score blob + history +
 * is_stale flag (true iff the cached profile_hash no longer matches
 * the current profile, meaning customer changed something since the
 * last run). Never spends API budget. */
profileScoreRouter.get(
  "/agents/:slug/profile-score",
  requireSlugOrAdminKey,
  (req: Request, res: Response) => {
    const { slug } = req.params;
    const db = getDb();
    const biz = db
      .prepare("SELECT * FROM businesses WHERE slug = ?")
      .get(slug) as BusinessRow | undefined;
    if (!biz) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const cached = readCache(biz);
    const history = readHistory(biz);
    if (!cached) {
      res.json({ slug, has_score: false, history, is_stale: false });
      return;
    }
    const currentHash = computeProfileHash(biz);
    const isStale = cached.profile_hash !== currentHash;
    res.json({
      slug,
      has_score: true,
      is_stale: isStale,
      ...cached,
      history,
    });
  },
);

/* POST /agents/:slug/profile-score
 * Hash-check + run.
 *   body: { query?: string, force?: boolean }
 *   force=true bypasses the cache and always runs fresh (cost: $0.04). */
profileScoreRouter.post(
  "/agents/:slug/profile-score",
  requireSlugOrAdminKey,
  async (req: Request, res: Response) => {
    const { slug } = req.params;
    const body = (req.body ?? {}) as { query?: unknown; force?: unknown };
    const force = body.force === true;
    const query =
      typeof body.query === "string" && body.query.trim().length > 0
        ? body.query.trim().slice(0, 200)
        : DEFAULT_QUERY(slug, slug);

    const db = getDb();
    const biz = db
      .prepare("SELECT * FROM businesses WHERE slug = ?")
      .get(slug) as BusinessRow | undefined;
    if (!biz) {
      res.status(404).json({ error: "Business not found" });
      return;
    }

    const currentHash = computeProfileHash(biz);
    const cached = readCache(biz);
    const history = readHistory(biz);

    // Cache hit: return cached score WITHOUT running the harness.
    // Same profile → same render → same score. The cached value IS
    // the legit score of the info currently being served.
    if (!force && cached && cached.profile_hash === currentHash) {
      res.json({
        slug,
        has_score: true,
        is_stale: false,
        cache_hit: true,
        ...cached,
        history,
      });
      return;
    }

    // Cache miss (or force) → run the harness fresh.
    try {
      const result = await runExperiment({
        profileSlugs: [slug],
        queries: [query],
        variantIds: ["perplexity_html", "openai_html", "claude_html", "google_html"],
      });

      const variantScores = result.summary.map((s) => ({
        variant_id: s.variant_id,
        score:      s.mean_citability,
        cite_rate:  s.cite_rate,
      }));
      const avgScore =
        variantScores.reduce((a, v) => a + v.score, 0) /
        Math.max(1, variantScores.length);
      const avgCite =
        variantScores.reduce((a, v) => a + v.cite_rate, 0) /
        Math.max(1, variantScores.length);

      const improvements = buildImprovements(
        result.trials.map((t) => ({
          variant_id: t.variant_id,
          reasoning: t.reasoning,
          citability_score: t.citability_score,
        })),
        slug,
      );

      const blob: CachedScore = {
        score:            Number(avgScore.toFixed(2)),
        score_max:        10,
        cite_rate:        Math.round(avgCite * 100),
        per_variant:      variantScores,
        improvements,
        sample_reasoning: result.trials[0]?.reasoning ?? "",
        run_at:           new Date().toISOString(),
        profile_hash:     currentHash,
      };

      writeCache(slug, blob, history);
      const newHistory = [
        ...history,
        { score: blob.score, cite_rate: blob.cite_rate, run_at: blob.run_at },
      ].slice(-HISTORY_CAP);

      res.json({
        slug,
        has_score: true,
        is_stale: false,
        cache_hit: false,
        ...blob,
        history: newHistory,
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
