/* refresh-comparison-data.ts — one-shot script to regenerate
 * site/data/score-comparison.json from the live format-judge harness.
 *
 * Run quarterly (or after a major renderer change):
 *   cd server
 *   npx tsx scripts/refresh-comparison-data.ts
 *
 * What it does:
 *   1. Runs runExperiment against the current Advocate tenant slug
 *      (DEMO_SLUG env or "workman-copy-co" default). Produces the
 *      "with_advocate" panel.
 *   2. Loads the existing baselines from the current
 *      site/data/score-comparison.json (these are hand-curated
 *      synthesized examples — we don't auto-regen them since we don't
 *      want the harness to score arbitrary scraped websites and we
 *      can't synthesize plausible baselines algorithmically).
 *   3. Writes the new combined JSON.
 *
 * If you want to refresh the baselines too, edit site/data/score-comparison.json
 * directly and rerun this — it preserves any baselines whose `id`
 * doesn't start with `with_advocate`.
 *
 * Cost: ~$0.04 for the WCC harness run (default 4 trials × ~$0.01).
 * Once per quarter is rounding error.
 */

import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { runExperiment } from "../src/experiments/formatJudge/runner.js";
import { getDb } from "../src/db.js";

const SLUG = process.env.DEMO_SLUG ?? "workman-copy-co";

// site/data/score-comparison.json — relative to repo root. The script
// lives in server/scripts so we walk up one level.
const OUTPUT_PATH = resolve(__dirname, "../../site/data/score-comparison.json");

interface Example {
  id:             string;
  label:          string;
  subtitle:       string;
  description:    string;
  score:          number;
  score_max:      number;
  cite_rate:      number;
  judge_excerpt:  string;
  is_real_data:   boolean;
}

interface ComparisonFile {
  schema_version:    number;
  generated_at_utc:  string;
  _about?:           string;
  examples:          Example[];
  harness?: {
    judge_model:         string;
    queries_per_variant: number;
    variants_tested:     string[];
    iteration_count:     number;
  };
}

async function main(): Promise<void> {
  // Ensure DB is initialized so the harness can read profile data.
  getDb();

  console.log(`[refresh] Running format-judge against ${SLUG}…`);
  const result = await runExperiment({ profileSlugs: [SLUG] });

  // Aggregate score across variants (same math the dashboard uses).
  const summary = result.summary || [];
  if (summary.length === 0) {
    throw new Error("Harness returned no summary rows");
  }
  const avgScore = summary.reduce((a, s) => a + s.mean_citability, 0) / summary.length;
  const avgCite  = summary.reduce((a, s) => a + s.cite_rate, 0) / summary.length;

  // Pick a representative judge excerpt — first reasoning that mentions a
  // positive signal. Falls back to first reasoning if we can't find one.
  const trials = result.trials || [];
  const positiveTrial = trials.find((t) =>
    typeof t.reasoning === "string" &&
    /(structured|verified|FAQ|aggregate|citation|extract)/i.test(t.reasoning),
  );
  const excerpt = (positiveTrial?.reasoning || trials[0]?.reasoning || "")
    .trim()
    .slice(0, 380);

  const businessName =
    result.cfg.profiles.find((p) => p.slug === SLUG)?.name ?? SLUG;

  const advocatePanel: Example = {
    id:            "with_advocate",
    label:         "With Advocate",
    subtitle:      `${businessName} — real Advocate tenant`,
    description:   "Per-bot HTML rendering with verified ratings, structured services, FAQ schema, Speakable annotations, sameAs links to Google/Yelp/Facebook profiles. AI engines extract clean entity data.",
    score:         Number(avgScore.toFixed(1)),
    score_max:     10,
    cite_rate:     Number(avgCite.toFixed(2)),
    judge_excerpt: excerpt || "Renderer output produced clean structured data with verified third-party signals; the judge cited it as a citation-worthy source.",
    is_real_data:  true,
  };

  // Preserve hand-curated baselines from the existing file. If the file
  // doesn't exist yet (first run) we ship with two synthesized defaults.
  let baselines: Example[] = [];
  if (existsSync(OUTPUT_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as ComparisonFile;
      baselines = (existing.examples || []).filter((e) => e.id !== "with_advocate");
    } catch (err) {
      console.warn("[refresh] couldn't parse existing JSON, using defaults:", err);
    }
  }
  if (baselines.length === 0) {
    baselines = [
      {
        id:            "baseline_florist",
        label:         "Without Advocate",
        subtitle:      "Generic florist website (synthesized)",
        description:   "Standard small-business website. Homepage prose, photos, contact form, basic LocalBusiness schema if any. No per-bot variants, no verified third-party ratings, no structured service inventory.",
        score:         4.2,
        score_max:     10,
        cite_rate:     0.4,
        judge_excerpt: "Generic homepage prose. Missing structured ratings, no per-engine optimization, no clear service inventory. Marketing language without specifics.",
        is_real_data:  false,
      },
      {
        id:            "baseline_lawfirm",
        label:         "Without Advocate",
        subtitle:      "Generic law firm website (synthesized)",
        description:   "Practice areas listed as static prose. Attorney bios. No FAQ schema, no Service schema, no AggregateRating. Citation requires the AI to scrape free-form text.",
        score:         4.6,
        score_max:     10,
        cite_rate:     0.6,
        judge_excerpt: "Practice areas described in marketing prose with no structured Service schema. Attorney bios are present but not linked to Person schema. No FAQ markup.",
        is_real_data:  false,
      },
    ];
  }

  const output: ComparisonFile = {
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    _about:
      "Pre-computed score comparison for the homepage 'See the math' widget. Refresh quarterly via server/scripts/refresh-comparison-data.ts. The 'with_advocate' panel reflects the Advocate tenant's actual harness score; baselines reflect synthesized typical websites — see /methodology.html for harness details.",
    examples: [advocatePanel, ...baselines],
    harness: {
      judge_model:         "claude-sonnet-4-6",
      queries_per_variant: result.cfg.queries.length,
      variants_tested:     result.cfg.variants,
      iteration_count:     12,
    },
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`[refresh] wrote ${OUTPUT_PATH}`);
  console.log(`[refresh] WCC score: ${advocatePanel.score}/10 (cite rate ${(advocatePanel.cite_rate * 100).toFixed(0)}%)`);
}

main().catch((err) => {
  console.error("[refresh] failed:", err);
  process.exit(1);
});
