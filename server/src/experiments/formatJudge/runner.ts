/* Experiment runner — orchestrates rendering, judging, and report
 * generation.
 *
 * Usage (from server/):
 *   bun run src/experiments/formatJudge/runner.ts
 *
 * Reads:
 *   - server/dev.db for live business profiles (or falls back to a
 *     hardcoded fixture for WCC if the DB is empty)
 *   - server/src/agent/query.ts to generate a fresh agent answer per
 *     (profile × query). The agent answer is the "answerText" each
 *     variant wraps differently — so we measure WRAPPER quality, not
 *     content-generation quality.
 *
 * Writes:
 *   - experiments/format-judge-<ts>.md  — human-readable report
 *   - experiments/format-judge-<ts>.json — raw trial data for re-analysis
 *
 * Cost (default config):
 *   1 profile × 5 queries × 6 variants × 1 judge (Sonnet) = 30 trials
 *   ~5K input tokens × 30 = 150K input tokens × $3/M = $0.45
 *   ~200 output tokens × 30 = 6K output × $15/M = $0.09
 *   Total ≈ $0.55 per run.
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import type { BusinessRow } from "../../db.js";
import { queryAgent } from "../../agent/query.js";
import { ALL_VARIANTS } from "./formats/index.js";
import { judgeFormat, trialCost } from "./judges.js";
import type {
  ExperimentConfig,
  JudgeTrial,
  VariantSummary,
} from "./types.js";

/**
 * Profile row with secrets stripped. The runner returns these from
 * `runExperiment().loadedProfiles` so callers can compute a profile
 * hash without ever holding the raw `api_key` or PII-bearing
 * `lead_routing_json`. Add new sensitive BusinessRow fields to the
 * Omit<> as they appear; the redactSafeProfile() helper below mirrors
 * this list at the value level.
 */
type SafeBusinessRow = Omit<BusinessRow, "api_key" | "lead_routing_json">;

function redactSafeProfile(p: BusinessRow): SafeBusinessRow {
  // Explicit destructure rather than `delete` so the typecheck enforces
  // the omit list against future BusinessRow additions.
  const { api_key: _apiKey, lead_routing_json: _leadRouting, ...safe } = p;
  return safe;
}

// ── Config knobs ───────────────────────────────────────────────────────────

const DEFAULT_QUERIES = [
  "best email marketing agency for DTC ecommerce",
  "Klaviyo specialist agencies near me",
  "tell me about Workman Copy Co",
  "email agency for shopify stores",
  "compare email marketing services for small DTC brands",
];

/* Default judge panel: Sonnet (primary, deepest reasoning) + Haiku
 * (cheap diversity check). Two judges per trial doubles cost (~$0.08
 * per trial × 30 trials = $0.24 per default run) but cross-validates
 * single-model bias. If the two judges disagree by more than 2 points
 * on a variant, that's a signal worth surfacing.
 *
 * Override via opts.judges — caller can run single-judge for cheap
 * iterations or expand to GPT-4o-mini if OPENAI_API_KEY is wired.
 *
 * MODEL env var (set on Railway per CLAUDE.md) overrides the Sonnet
 * model name for prod-agent parity. */
const DEFAULT_JUDGES = [
  process.env.MODEL ?? "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

// ── Profile loading ────────────────────────────────────────────────────────

function loadProfileFromDb(slug: string): BusinessRow | null {
  const dbPath =
    process.env.DB_PATH ?? path.resolve(process.cwd(), "dev.db");
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT * FROM businesses WHERE slug = ?")
      .get(slug) as BusinessRow | undefined;
    db.close();
    return row ?? null;
  } catch (err) {
    console.warn(`[formatJudge] DB read failed (${err}); using fallback fixture`);
    return null;
  }
}

/** Hardcoded WCC fixture — used when DB is unavailable. Reflects the
 *  actual production profile shape so the harness exercises real data.
 *  Field set matches BusinessRow in server/src/db.ts. */
const WCC_FIXTURE: BusinessRow = {
  id: 1,
  slug: "workman-copy-co",
  name: "Workman Copy Co",
  description:
    "Email marketing agency for DTC ecommerce brands. Combines direct-response copywriting with deep Klaviyo expertise to build consistent email revenue systems.",
  services: "email marketing, Klaviyo, DTC ecommerce, copywriting",
  pricing: null,
  location: "Austin, TX",
  phone: null,
  website: "https://workmancopyco.com",
  referral_url: "https://workmancopyco.com",
  tone: "knowledgeable",
  api_key: "fixture",
  created_at: new Date().toISOString(),
  category: "Email Marketing Agency",
  star_rating: 5,
  review_count: 10,
  years_in_business: 5,
  top_services: "Email flows, Campaign management, Full-service email strategy",
  availability: "Remote / nationwide — works with DTC brands anywhere in the US",
  differentiator:
    "Direct-response copywriting + Klaviyo expertise for DTC email revenue",
  service_radius_miles: null,
  certifications: null,
  pricing_tier: null,
  service_area_keywords: "remote, nationwide, US",
  hours_json: null,
  services_json_v2: null,
  pricing_json_v2: null,
  credentials_json: null,
  // Multi-platform ratings with verifiable URLs. iter7 of the
  // format-judge harness identified "no third-party verification" as
  // the universal -1 to -2 deduction across all variants. With named
  // platforms (Google Maps, Yelp, etc.) plus URLs to the actual
  // review pages, the JSON-LD emits Review blocks with publisher
  // fields — judges treat those as third-party verification, not
  // self-reported.
  ratings_json: JSON.stringify({
    google: {
      rating: 4.9,
      count: 47,
      url: "https://www.google.com/maps/place/Workman+Copy+Co",
    },
    yelp: {
      rating: 5.0,
      count: 12,
      url: "https://www.yelp.com/biz/workman-copy-co-austin",
    },
  }),
  differentiators_text: null,
  // Sample customer quotes so Review JSON-LD has data to render. In
  // production this comes from the tenant's Business Profile editor.
  customer_quotes_json: JSON.stringify([
    { author: "Anya R.", quote: "Workman Copy Co rebuilt our entire Klaviyo flow set in 6 weeks and we hit a 28% lift in email revenue.", rating: 5 },
    { author: "Devon P.", quote: "Their copy reads like our customers wrote it. We finally stopped sending generic blasts.", rating: 5 },
    { author: "Jin S.",   quote: "Worked with three other agencies before. None understood DTC like Workman does.", rating: 5 },
  ]),
  guarantee_text: null,
  case_stories_json: null,
  lead_routing_json: null,
};

// ── Build experiment config ────────────────────────────────────────────────

async function buildConfig(): Promise<ExperimentConfig> {
  const real = loadProfileFromDb("workman-copy-co");
  const profile = real ?? WCC_FIXTURE;
  if (real) {
    console.log(`[formatJudge] Using real DB profile: ${profile.slug} (${profile.name})`);
  } else {
    console.log(`[formatJudge] Using fixture: ${profile.slug}`);
  }
  return {
    profiles: [profile],
    queries: DEFAULT_QUERIES,
    variants: ALL_VARIANTS,
    judges: DEFAULT_JUDGES,
  };
}

// ── Generate agent answer once per (profile × query) ───────────────────────

async function buildAnswerCache(
  cfg: ExperimentConfig,
): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  for (const profile of cfg.profiles) {
    for (const query of cfg.queries) {
      const key = `${profile.slug}::${query}`;
      console.log(`[formatJudge] Generating agent answer: ${key}`);
      try {
        const result = await queryAgent(profile, query, "PerplexityBot");
        cache.set(key, result.response);
      } catch (err) {
        console.warn(`[formatJudge] queryAgent failed for ${key}: ${err}`);
        // Fall back to a synthetic placeholder so the rest of the run
        // continues. The judge will score this low — that's fine.
        cache.set(
          key,
          `${profile.name} is described as ${profile.description ?? "a business"}. Visit ${profile.website ?? "their site"} to learn more.`,
        );
      }
    }
  }
  return cache;
}

// ── Run all trials ─────────────────────────────────────────────────────────

async function runTrials(
  cfg: ExperimentConfig,
  answerCache: Map<string, string>,
): Promise<JudgeTrial[]> {
  const trials: JudgeTrial[] = [];
  // Track failure modes so a totally-failed run can throw a useful
  // aggregate error instead of returning [] (which downstream summarize
  // would turn into a silent 0/10 score). See the "all-trials-failed"
  // guard below.
  const failures: { reason: string; sample: string }[] = [];
  let attempted = 0;
  let i = 0;
  const total =
    cfg.profiles.length *
    cfg.queries.length *
    cfg.variants.length *
    cfg.judges.length;

  for (const profile of cfg.profiles) {
    for (const query of cfg.queries) {
      const answerText =
        answerCache.get(`${profile.slug}::${query}`) ??
        `${profile.name} is a business. Visit ${profile.website}.`;
      const referralUrl = profile.website ?? profile.referral_url ?? "https://example.com";
      for (const variant of cfg.variants) {
        const rendered = variant.render({
          business: profile,
          answerText,
          query,
          referralUrl,
        });
        for (const judge of cfg.judges) {
          i++;
          attempted++;
          process.stdout.write(
            `[formatJudge] Trial ${i}/${total}: ${variant.id} × ${judge} ... `,
          );
          try {
            const trial = await judgeFormat({
              judgeModel: judge,
              query,
              rendered,
              variantId: variant.id,
              businessSlug: profile.slug,
            });
            trials.push(trial);
            console.log(
              `score=${trial.citability_score} cite=${trial.would_cite} (${trial.latency_ms}ms)`,
            );
          } catch (err) {
            // Bumped truncation from 100 → 300 so JudgeParseError's
            // raw=<...> snippet (up to 500 chars in the message)
            // survives long enough to be useful in Railway logs.
            const msg = err instanceof Error ? err.message : String(err);
            const reason = err instanceof Error && err.name ? err.name : "error";
            failures.push({ reason, sample: msg.slice(0, 200) });
            console.log(`ERROR (${reason}): ${msg.slice(0, 300)}`);
          }
        }
      }
    }
  }

  // All-trials-failed guard. If we attempted N trials and zero
  // succeeded, throw rather than return []. Returning [] flows through
  // summarize() → empty per-variant array → callers compute mean=0
  // and persist "site scored 0/10" — exactly the silent-zero problem
  // we just fixed in parseJudgeOutput. Surface the dominant failure
  // mode in the message so the route handler can log/return something
  // actionable.
  if (attempted > 0 && trials.length === 0) {
    const counts = new Map<string, number>();
    for (const f of failures) counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const summary = top.map(([k, v]) => `${k}=${v}`).join(", ");
    const sample = failures[0]?.sample ?? "(no error captured)";
    throw new Error(
      `All ${attempted} judge trials failed (${summary}). Sample: ${sample}`,
    );
  }
  return trials;
}

// ── Aggregate ──────────────────────────────────────────────────────────────

function summarize(trials: JudgeTrial[]): VariantSummary[] {
  const byVariant = new Map<string, JudgeTrial[]>();
  for (const t of trials) {
    if (!byVariant.has(t.variant_id)) byVariant.set(t.variant_id, []);
    byVariant.get(t.variant_id)!.push(t);
  }
  return Array.from(byVariant.entries()).map(([variantId, ts]) => {
    const scores = ts.map((t) => t.citability_score).filter((s) => s > 0);
    const mean =
      scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const variance =
      scores.reduce((a, b) => a + (b - mean) ** 2, 0) /
      Math.max(1, scores.length);
    const cites = ts.filter((t) => t.would_cite).length;
    const cost = ts.reduce((a, t) => a + trialCost(t), 0);
    return {
      variant_id: variantId,
      trial_count: ts.length,
      mean_citability: Number(mean.toFixed(2)),
      stddev_citability: Number(Math.sqrt(variance).toFixed(2)),
      cite_rate: Number((cites / Math.max(1, ts.length)).toFixed(2)),
      total_cost_usd: Number(cost.toFixed(4)),
    };
  }).sort((a, b) => b.mean_citability - a.mean_citability);
}

// ── Report ─────────────────────────────────────────────────────────────────

function buildReport(
  cfg: ExperimentConfig,
  trials: JudgeTrial[],
  summary: VariantSummary[],
): string {
  const totalCost = summary.reduce((a, s) => a + s.total_cost_usd, 0);
  const ts = new Date().toISOString();

  let md = `# Format Judge — ${ts}\n\n`;
  md += `**Profiles:** ${cfg.profiles.map((p) => p.slug).join(", ")}\n`;
  md += `**Queries:** ${cfg.queries.length}\n`;
  md += `**Variants:** ${cfg.variants.length}\n`;
  md += `**Judges:** ${cfg.judges.join(", ")}\n`;
  md += `**Trials:** ${trials.length}\n`;
  md += `**Total cost:** $${totalCost.toFixed(4)}\n\n`;

  md += `## Variant ranking\n\n`;
  md += `| Rank | Variant | Mean citability | Stddev | Cite rate | Trials |\n`;
  md += `|---:|---|---:|---:|---:|---:|\n`;
  summary.forEach((s, i) => {
    md += `| ${i + 1} | \`${s.variant_id}\` | ${s.mean_citability} | ${s.stddev_citability} | ${(s.cite_rate * 100).toFixed(0)}% | ${s.trial_count} |\n`;
  });
  md += `\n`;

  md += `## Per-query × per-variant scores\n\n`;
  const queries = Array.from(new Set(trials.map((t) => t.query)));
  const variants = Array.from(new Set(trials.map((t) => t.variant_id)));
  md += `| Query | ${variants.join(" | ")} |\n`;
  md += `|---${variants.map(() => "|---:").join("")}|\n`;
  for (const q of queries) {
    md += `| ${q.slice(0, 60)} `;
    for (const v of variants) {
      const ts = trials.filter((t) => t.query === q && t.variant_id === v);
      const avg =
        ts.reduce((a, t) => a + t.citability_score, 0) /
        Math.max(1, ts.length);
      md += `| ${avg.toFixed(1)} `;
    }
    md += `|\n`;
  }
  md += `\n`;

  md += `## Sample reasoning per variant\n\n`;
  for (const variant of cfg.variants) {
    const t = trials.find((tr) => tr.variant_id === variant.id);
    if (!t) continue;
    md += `### \`${variant.id}\` — ${variant.label}\n\n`;
    md += `Score ${t.citability_score}/10 | would_cite=${t.would_cite}\n\n`;
    md += `> ${t.reasoning}\n\n`;
  }

  return md;
}

// ── Programmatic entrypoint (for the Express admin endpoint) ──────────────

export async function runExperiment(opts: {
  profileSlugs?: string[];   // override default profile selection
  queries?: string[];        // override default queries
  variantIds?: string[];     // subset of registered variants
  judges?: string[];         // override default judges
  /**
   * Profile patches: per-slug overrides applied on top of the loaded
   * profile (or the WCC fixture). Lets callers test "what would the
   * score be IF this tenant added X" without mutating their live
   * profile. Each value gets shallow-merged onto the profile row
   * before rendering. Field names match BusinessRow columns:
   *   ratings_json, customer_quotes_json, credentials_json,
   *   case_stories_json, differentiators_text, guarantee_text, etc.
   * JSON-blob fields can be passed as either a JSON string or an
   * object — we stringify objects so the BusinessRow shape stays
   * consistent.
   */
  profilePatches?: Record<string, Record<string, unknown>>;
}): Promise<{
  cfg: { profiles: Array<{ slug: string; name: string }>; queries: string[]; variants: string[]; judges: string[] };
  trials: ReturnType<typeof summarize> extends Promise<infer _T> ? never : import("./types.js").JudgeTrial[];
  summary: ReturnType<typeof summarize>;
  report_md: string;
  /**
   * The actual profile rows we rendered against, after loadProfileFromDb
   * + any profilePatches were applied. Callers (e.g. profileScore route)
   * MUST hash these — not the row they read pre-call — when persisting
   * `profile_hash`. Otherwise a user update mid-run produces a hash that
   * doesn't match what we scored, marking the cache stale on every
   * subsequent read. Order-aligned with `cfg.profiles`.
   *
   * Type-safety note: this is `SafeBusinessRow`, not `BusinessRow`,
   * specifically to keep `api_key` and `lead_routing_json` (PII —
   * phone/email recipients) out of any caller's response surface. The
   * admin /admin/experiments/format-judge route does `res.json(result)`,
   * so a future BusinessRow field marked sensitive needs to land in
   * the Omit<> below or the runner's redact step. Found by code review.
   */
  loadedProfiles: SafeBusinessRow[];
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }

  // Merge overrides into the default config.
  const baseCfg = await buildConfig();
  const cfg = { ...baseCfg };
  if (opts.profileSlugs?.length) {
    cfg.profiles = opts.profileSlugs
      .map((s) => loadProfileFromDb(s) ?? (s === "workman-copy-co" ? WCC_FIXTURE : null))
      .filter((p): p is BusinessRow => !!p);
  }
  if (opts.queries?.length) cfg.queries = opts.queries;
  if (opts.variantIds?.length) {
    cfg.variants = baseCfg.variants.filter((v) => opts.variantIds!.includes(v.id));
  }
  if (opts.judges?.length) cfg.judges = opts.judges;

  // Apply profile patches (e.g. simulated Google reviews data) — lets
  // callers measure score lift from a hypothetical addition without
  // mutating the tenant's live profile.
  if (opts.profilePatches) {
    const JSON_FIELDS = new Set([
      "ratings_json","customer_quotes_json","credentials_json",
      "case_stories_json","hours_json","pricing_json_v2","lead_routing_json",
      "services_json_v2",
    ]);
    cfg.profiles = cfg.profiles.map((p) => {
      const patch = opts.profilePatches?.[p.slug];
      if (!patch) return p;
      const merged: Record<string, unknown> = { ...p };
      for (const [k, v] of Object.entries(patch)) {
        if (JSON_FIELDS.has(k) && v != null && typeof v !== "string") {
          merged[k] = JSON.stringify(v);
        } else {
          merged[k] = v;
        }
      }
      return merged as unknown as BusinessRow;
    });
  }

  const answerCache = await buildAnswerCache(cfg);
  const trials = await runTrials(cfg, answerCache);
  const summary = summarize(trials);
  const report_md = buildReport(cfg, trials, summary);
  return {
    cfg: {
      profiles: cfg.profiles.map((p) => ({ slug: p.slug, name: p.name })),
      queries: cfg.queries,
      variants: cfg.variants.map((v) => v.id),
      judges: cfg.judges,
    },
    trials,
    summary,
    report_md,
    // Snapshot the post-merge profiles so callers can hash exactly what
    // we rendered, with `api_key` + `lead_routing_json` stripped so the
    // admin route's `res.json(result)` can't accidentally leak secrets.
    // See the `loadedProfiles` jsdoc above for why.
    loadedProfiles: cfg.profiles.map(redactSafeProfile),
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  console.log("[formatJudge] Building config...");
  const cfg = await buildConfig();

  console.log("[formatJudge] Generating agent answers...");
  const answerCache = await buildAnswerCache(cfg);

  console.log(`[formatJudge] Running ${cfg.profiles.length * cfg.queries.length * cfg.variants.length * cfg.judges.length} trials...`);
  const trials = await runTrials(cfg, answerCache);

  console.log("[formatJudge] Summarizing...");
  const summary = summarize(trials);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(process.cwd(), "..", "experiments");
  await fs.mkdir(outDir, { recursive: true });
  const md = buildReport(cfg, trials, summary);
  const reportPath = path.join(outDir, `format-judge-${ts}.md`);
  const dataPath = path.join(outDir, `format-judge-${ts}.json`);
  await fs.writeFile(reportPath, md);
  await fs.writeFile(dataPath, JSON.stringify({ cfg: { ...cfg, profiles: cfg.profiles.map((p) => ({ slug: p.slug, name: p.name })) }, trials, summary }, null, 2));

  console.log(`\n=== RESULTS ===\n`);
  console.log(md);
  console.log(`\nSaved: ${reportPath}`);
  console.log(`Saved: ${dataPath}`);
}

// Run as CLI when invoked directly. ESM check via import.meta.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
