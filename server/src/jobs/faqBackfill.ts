/**
 * FAQ backfill cron (Phase 1 of grey-hat AI optimization layer).
 *
 * Finds businesses with NULL `faqs_json` (the migration creates this state
 * for every legacy tenant) and generates 10–15 leading-question Q&As for
 * each via `faqGenerator.generateLeadingFaqs()`. Writes back atomically.
 *
 * Idempotency: the cron is naturally idempotent — once a row has
 * `faqs_json` populated, it's no longer in the candidate set. If the
 * generator partially fails (e.g. validator drops all entries), we leave
 * `faqs_generated_at` NULL and the next run picks the row up again.
 *
 * Failure isolation: per-tenant try/catch — one tenant's API error
 * doesn't stop the batch. Errors are logged with the slug so operators
 * can spot patterns (e.g. tenant with malformed `services_json_v2`
 * crashing the generator).
 *
 * Cost guardrail: env var `FAQ_DAILY_GENERATION_CAP` (default 100).
 * Counted against `businesses.faqs_generated_at >= today UTC midnight`.
 * At ~$0.025 per generation that's ~$2.50/day cap. Phase 3 will replace
 * this with a unified cost-cents column on `agent_requests` so all four
 * grey-hat generators share one budget; for Phase 1 a count cap is
 * simpler and equally bounded.
 *
 * Schedule:
 *   - Default `0 3 * * *` (daily 03:00 UTC, after radar/digest jobs).
 *   - Override via `FAQ_BACKFILL_CRON` env var.
 *   - Gated on `ANTHROPIC_API_KEY` AND `FEATURE_FAQS_V2` env flag.
 *
 * Apr 28 2026.
 */

import cron from "node-cron";
import { getDb } from "../db.js";
import { generateLeadingFaqs } from "../agent/faqGenerator.js";
import type { BusinessRow } from "../db.js";

const DEFAULT_SCHEDULE = "0 3 * * *";  // 03:00 UTC daily
const DEFAULT_BATCH_SIZE = 50;          // tenants per cron tick
const DEFAULT_DAILY_GENERATION_CAP = 100;

/**
 * Single-pass backfill: pick up to BATCH_SIZE candidates and generate
 * FAQs for each. Per-tenant cost gets summed into a daily total and
 * compared against the budget cap before the next call fires.
 *
 * Exposed for manual invocation from /admin/jobs/faq-backfill (operator
 * tool) and tests. Returns counters for observability.
 */
export interface FaqBackfillResult {
  considered: number;
  generated:  number;
  skipped:    number;
  errors:     number;
  cost_cents_total: number;
}

export async function runFaqBackfill(
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<FaqBackfillResult> {
  const db = getDb();

  const result: FaqBackfillResult = {
    considered: 0, generated: 0, skipped: 0, errors: 0, cost_cents_total: 0,
  };

  // Daily generation-count cap (Phase 1 simplification — Phase 3 will
  // replace with a unified cost-cents budget across all grey-hat
  // generators).
  const cap = Number.parseInt(
    process.env.FAQ_DAILY_GENERATION_CAP ?? String(DEFAULT_DAILY_GENERATION_CAP),
    10,
  );
  const todayUtcMs = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();
  const todayCountRow = db.prepare(
    "SELECT COUNT(*) AS n FROM businesses WHERE faqs_generated_at >= ?",
  ).get(todayUtcMs) as { n: number } | undefined;
  const generatedToday = todayCountRow?.n ?? 0;
  if (generatedToday >= cap) {
    console.warn(`[faq-backfill] daily cap hit (${generatedToday}/${cap}); skipping run.`);
    return result;
  }
  // Reduce batch size if we're approaching the cap — don't generate
  // more than the remaining headroom.
  const remainingHeadroom = cap - generatedToday;
  const effectiveBatch = Math.min(batchSize, remainingHeadroom);

  // Candidate selection — businesses where faqs_json IS NULL. Limit to
  // batch size so a backlog of N tenants spreads over N/batch_size cron
  // ticks rather than burning the entire budget on day 1.
  const candidates = db.prepare(
    "SELECT * FROM businesses WHERE faqs_json IS NULL LIMIT ?",
  ).all(effectiveBatch) as BusinessRow[];
  result.considered = candidates.length;

  const updateStmt = db.prepare(
    "UPDATE businesses \
       SET faqs_json = ?, faqs_generated_at = ?, faqs_source = 'claude' \
     WHERE id = ?",
  );

  for (const biz of candidates) {
    try {
      const out = await generateLeadingFaqs(biz);
      // Empty array is a real (but rare) outcome — generator may legitimately
      // skip every question if the source profile is too sparse. Don't write
      // an empty array; leave NULL so a future re-onboard with fuller data
      // re-attempts. Skip instead of marking as success.
      if (out.faqs.length < 3) {
        result.skipped++;
        console.warn(`[faq-backfill] ${biz.slug}: only ${out.faqs.length} valid FAQs (rejected ${out.rejected}); leaving NULL.`);
        continue;
      }
      updateStmt.run(JSON.stringify(out.faqs), Date.now(), biz.id);
      result.generated++;
      result.cost_cents_total += out.cost_cents;
      console.log(`[faq-backfill] ${biz.slug}: ${out.faqs.length} FAQs (rejected ${out.rejected}; ${out.cost_cents.toFixed(2)}¢)`);

      // Stop early if we've generated up to the cap mid-batch.
      if (generatedToday + result.generated >= cap) {
        console.warn(`[faq-backfill] daily cap hit mid-batch; stopping early.`);
        break;
      }
    } catch (err) {
      result.errors++;
      console.error(`[faq-backfill] ${biz.slug}: error`, err);
    }
  }

  return result;
}

/**
 * Register the scheduled cron. Call once from index.ts at boot. Silent
 * no-op when:
 *   - ANTHROPIC_API_KEY is unset (dev / test deploys)
 *   - FEATURE_FAQS_V2 is unset or 'false' (gradual rollout / rollback)
 *   - cron expression is malformed (operator typo)
 *
 * Same gate pattern as `weeklyDigest.ts:startWeeklyDigestSchedule()`.
 */
export function startFaqBackfillSchedule(): void {
  const flag = (process.env.FEATURE_FAQS_V2 ?? "").toLowerCase();
  if (flag !== "true" && flag !== "1") {
    console.log("[faq-backfill] FEATURE_FAQS_V2 disabled; cron NOT scheduled.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[faq-backfill] ANTHROPIC_API_KEY missing; cron NOT scheduled.");
    return;
  }
  const schedule = process.env.FAQ_BACKFILL_CRON ?? DEFAULT_SCHEDULE;
  if (!cron.validate(schedule)) {
    console.warn(`[faq-backfill] invalid cron '${schedule}'; cron NOT scheduled.`);
    return;
  }
  cron.schedule(schedule, () => {
    runFaqBackfill().catch((err) => {
      console.error("[faq-backfill] runFaqBackfill threw:", err);
    });
  });
  console.log(`[faq-backfill] scheduled: ${schedule}`);
}
