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
import { requireServerKeyOnly } from "../middleware/auth.js";
import { rateLimit, checkLimit } from "../middleware/costRateLimit.js";
import { reserve as budgetReserve, record as budgetRecord, release as budgetRelease } from "../middleware/budgetKillSwitch.js";
import { reserveForSlug, recordForSlug, releaseForSlug } from "../middleware/tenantBudget.js";
import type { BusinessRow } from "../db.js";

export const profileScoreRouter = Router();

/* Rate limits on /agents/:slug/profile-score (fresh runs only).
 *
 * Each fresh run = ~$0.04 in Anthropic API spend. Without a cap, a
 * compromised session or runaway client could rack up thousands in
 * a few minutes. Two-tier per-slug bucket:
 *   - 3 fresh runs per 60 seconds  (burst protection — covers
 *     auto-rerun-on-save races without blocking legitimate ops).
 *   - 60 fresh runs per 24 hours   (~$2.40/day max per tenant —
 *     well above any realistic legit usage).
 *
 * Cache HITS do not consume a slot (they spend nothing). We
 * checkLimit() only after we determine the request is going to
 * actually run fresh. The 60s debounce on the client already
 * collapses save spree → 1 fresh run; this is server-side
 * defense-in-depth.
 *
 * Limits are scoped per slug. Different tenants can run in parallel
 * without interfering with each other. */
const PROFILE_SCORE_LIMITS = [
  { label: "profile-score:burst", cfg: { max: 3,  windowMs: 60_000 } },
  { label: "profile-score:daily", cfg: { max: 60, windowMs: 24 * 60 * 60_000 } },
];

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

/**
 * Persist `blob` as the latest score and append a history entry. Reads
 * the current history *inside* the same SQLite transaction as the
 * UPDATE so two concurrent runs can't both read N entries, both append,
 * and last-writer-wins drop one of the two new rows. Returns the
 * newly-persisted history list (caller uses it for the response).
 *
 * Pre-fix this took a `prevHistory` arg captured at request-start time.
 * That's the actual race: prevHistory was read at T0, runExperiment
 * ran for ~10s, the row could change underneath, and the write would
 * regress whatever else landed mid-flight. The transactional re-read
 * fixes it. (Bug 1.)
 */
function writeCache(slug: string, blob: CachedScore): HistoryEntry[] {
  const db = getDb();
  const tx = db.transaction((s: string): HistoryEntry[] => {
    const row = db
      .prepare("SELECT score_history_json FROM businesses WHERE slug = ?")
      .get(s) as { score_history_json: string | null } | undefined;
    let prevHistory: HistoryEntry[] = [];
    if (row?.score_history_json) {
      try {
        const parsed = JSON.parse(row.score_history_json);
        if (Array.isArray(parsed)) prevHistory = parsed as HistoryEntry[];
      } catch { /* malformed JSON → start a fresh history */ }
    }
    const merged: HistoryEntry[] = [
      ...prevHistory,
      { score: blob.score, cite_rate: blob.cite_rate, run_at: blob.run_at },
    ].slice(-HISTORY_CAP);
    db.prepare(
      `UPDATE businesses
         SET last_score_json = ?, score_history_json = ?
       WHERE slug = ?`,
    ).run(JSON.stringify(blob), JSON.stringify(merged), s);
    return merged;
  });
  return tx(slug);
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
  requireServerKeyOnly,
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
  requireServerKeyOnly,
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
    // Two gates BEFORE we start spending API budget:
    //   1. Per-slug rate limit (cache hits skip this entirely).
    //   2. Daily-total kill-switch (across all tenants × all
    //      endpoints) — last line of defense against multi-tenant
    //      amplification attacks.
    const gate = checkLimit({ key: slug, limits: PROFILE_SCORE_LIMITS });
    if (!gate.allowed) {
      const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "rate_limited",
        message: `Too many fresh runs for ${slug} (${gate.label}). Try again in ${retryAfterSec}s.`,
        retry_after_seconds: retryAfterSec,
      });
      return;
    }

    // Reserve budget for this run. Default profile-score config:
    // 4 trials × ~$0.01 each = $0.04. Reserve $0.08 to stay clear
    // of edge cases.
    //
    // Two-stage reserve: per-tenant cap first (cheaper to fail-fast,
    // and the more common limiter for an actively-running tenant),
    // then global cap. If global fails after per-tenant succeeds we
    // must release the per-tenant reservation — done explicitly below.
    const RESERVATION_USD = 0.08;
    const tenantBudget = reserveForSlug(slug, RESERVATION_USD);
    if (!tenantBudget.allowed) {
      res.status(503).json({
        error: "tenant_budget_exhausted",
        message: `Per-tenant daily AI budget exhausted for ${slug} ($${tenantBudget.capUsd.toFixed(2)} cap, $${tenantBudget.remainingUsd.toFixed(2)} left). Try again after UTC midnight or contact support to raise.`,
        remaining_usd: tenantBudget.remainingUsd,
        cap_usd: tenantBudget.capUsd,
        scope: "tenant",
      });
      return;
    }
    const budget = budgetReserve(RESERVATION_USD);
    if (!budget.allowed) {
      // Roll back per-tenant reservation since we're not running.
      releaseForSlug(slug, RESERVATION_USD);
      res.status(503).json({
        error: "budget_exhausted",
        message: `Daily AI budget exhausted ($${budget.capUsd.toFixed(2)} cap, $${budget.remainingUsd.toFixed(2)} left). Try again after UTC midnight.`,
        remaining_usd: budget.remainingUsd,
        cap_usd: budget.capUsd,
        scope: "global",
      });
      return;
    }

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

      // Hash the profile we ACTUALLY rendered against, not the one we
      // read at line ~310 to gate the cache hit. runExperiment does its
      // own loadProfileFromDb internally; if the user updated the
      // profile between our pre-call read and runExperiment's load,
      // those two rows differ. Persisting the pre-call hash would
      // mark the cache stale on the very next read and force a needless
      // re-run. Falling back to currentHash if the runner didn't return
      // a row keeps behavior backward-compatible. (Bug 4.)
      const renderedProfile = result.loadedProfiles[0];
      const persistedHash = renderedProfile
        ? computeProfileHash(renderedProfile)
        : currentHash;

      const blob: CachedScore = {
        score:            Number(avgScore.toFixed(2)),
        score_max:        10,
        cite_rate:        Math.round(avgCite * 100),
        per_variant:      variantScores,
        improvements,
        sample_reasoning: result.trials[0]?.reasoning ?? "",
        run_at:           new Date().toISOString(),
        profile_hash:     persistedHash,
      };

      // writeCache now returns the post-merge history list — it's the
      // authoritative result of the transactional read+write inside
      // SQLite. The previous code recomputed the list in JS from the
      // request-start `history` snapshot, which suffered the same race
      // we just fixed in writeCache. (Bug 1.)
      const newHistory = writeCache(slug, blob);

      // Record actual spend against BOTH budgets. Approximate from the
      // experiment's reported total_cost (sum of trial costs). Order
      // doesn't matter — both modules are idempotent on the
      // (reserved_max, actual) tuple.
      const actualCost = (result.summary || []).reduce(
        (a, s) => a + (s.total_cost_usd || 0),
        0,
      );
      budgetRecord(RESERVATION_USD, actualCost);
      recordForSlug(slug, RESERVATION_USD, actualCost);

      res.json({
        slug,
        has_score: true,
        is_stale: false,
        cache_hit: false,
        ...blob,
        history: newHistory,
      });
    } catch (err) {
      // Failure: release BOTH reservations so neither budget
      // permanently burns headroom for a request that didn't incur
      // cost. Order doesn't matter; both releases are idempotent.
      budgetRelease(RESERVATION_USD);
      releaseForSlug(slug, RESERVATION_USD);
      console.error(`[profile-score] ${slug} failed:`, err);
      res.status(500).json({
        error: "score_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
);
