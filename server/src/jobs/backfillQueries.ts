/**
 * Backfill job for Layer 1 columns on historical queries rows.
 *
 * Migration 020 adds columns nullable so the deploy is non-blocking. This
 * job fills them in on existing rows:
 *
 *   industry_code  — derived from businesses.category via classifyIndustry()
 *   intent_v2      — Haiku-classified from query_text
 *   tokens_in/out  — unknown for historical rows (Claude response is gone)
 *   cost_cents     — unknown for historical rows
 *   model          — unknown for historical rows
 *   geo_*          — unknown for historical rows (edge geo wasn't captured)
 *
 * The unknowables stay NULL. Aggregate views treat NULL explicitly rather
 * than guessing.
 *
 * Run pattern:
 *   - Nightly via cron scheduler (registered in routes/entry), modelled
 *     on reputationRollup.ts.
 *   - Batched at BATCH_SIZE rows per pass to bound memory + classifier
 *     fan-out.
 *   - Idempotent: COALESCE in the UPDATE preserves any value already set
 *     (a manual correction wins over the classifier's guess).
 *   - Budget-aware: honours INTENT_BACKFILL_DAILY_BUDGET_CENTS. Per
 *     classification costs ~$0.0000024, so 1000 rows is under a penny —
 *     the budget exists mostly as a circuit breaker against a runaway
 *     Haiku API bill if we ever point at a huge historical dataset.
 */

import { getDb } from "../db.js";
import { classifyIntent } from "../agent/classify.js";
import { classifyIndustry, isIntentV2, type IntentV2 } from "../agent/taxonomy.js";

const BATCH_SIZE  = parseInt(process.env.BACKFILL_BATCH_SIZE ?? "250", 10);
const DAILY_BUDGET_CENTS = parseInt(process.env.INTENT_BACKFILL_DAILY_BUDGET_CENTS ?? "100", 10);

export interface BackfillResult {
  scanned: number;
  industry_filled: number;
  intent_filled: number;
  errors: number;
  cost_cents: number;
  budget_halted: boolean;
}

/**
 * Pure helper: fill industry_code from joined businesses.category. Cheap,
 * no external API, runs in a single SQL pass.
 */
export function backfillIndustries(): { filled: number } {
  const db = getDb();
  const rows = db.prepare(
    `SELECT q.id AS id, b.category AS category
       FROM queries q
       JOIN businesses b ON b.slug = q.business_slug
      WHERE q.industry_code IS NULL`
  ).all() as { id: number; category: string | null }[];

  const stmt = db.prepare(`UPDATE queries SET industry_code = ? WHERE id = ? AND industry_code IS NULL`);
  let filled = 0;
  for (const r of rows) {
    stmt.run(classifyIndustry(r.category), r.id);
    filled++;
  }
  return { filled };
}

/**
 * Run one backfill pass for intent_v2. Bounded by BATCH_SIZE and the
 * configured daily budget. Returns the counters so callers can log and
 * alert on abnormalities.
 */
export async function backfillIntentV2(): Promise<BackfillResult> {
  const db = getDb();
  const industryOut = backfillIndustries();

  const rows = db.prepare(
    `SELECT q.id AS id, q.query_text AS query_text, b.name AS business_name
       FROM queries q
  LEFT JOIN businesses b ON b.slug = q.business_slug
      WHERE q.intent_v2 IS NULL
        AND q.query_text IS NOT NULL
      ORDER BY q.id DESC
      LIMIT ?`
  ).all(BATCH_SIZE) as { id: number; query_text: string; business_name: string | null }[];

  const result: BackfillResult = {
    scanned: rows.length,
    industry_filled: industryOut.filled,
    intent_filled: 0,
    errors: 0,
    cost_cents: 0,
    budget_halted: false,
  };

  const updateStmt = db.prepare(
    `UPDATE queries SET intent_v2 = COALESCE(intent_v2, ?) WHERE id = ?`
  );

  for (const row of rows) {
    if (result.cost_cents >= DAILY_BUDGET_CENTS) {
      result.budget_halted = true;
      break;
    }
    try {
      const out = await classifyIntent({
        query: row.query_text,
        businessName: row.business_name ?? undefined,
      });
      result.cost_cents += out.cost_cents;
      if (isIntentV2(out.intent)) {
        updateStmt.run(out.intent as IntentV2, row.id);
        result.intent_filled++;
      }
    } catch (err) {
      result.errors++;
      console.error(JSON.stringify({
        event: "backfill_classify_error",
        query_id: row.id,
        error: String(err instanceof Error ? err.message : err),
      }));
    }
  }

  return result;
}

/**
 * Scheduler entry. Registered by the app bootstrap alongside
 * reputationRollup / expirySweeper. Runs once on boot, then daily at
 * 03:00 UTC (low-traffic window).
 *
 * Not unref'd — we want tests to catch a hung classifier rather than
 * silently exit. Production boot stays running so the interval is fine.
 */
export function startBackfillSchedule(): NodeJS.Timer | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(JSON.stringify({ event: "backfill_skipped_no_api_key" }));
    return null;
  }
  // Boot pass — useful for catching up after a deploy.
  void backfillIntentV2().then((res) => {
    console.log(JSON.stringify({ event: "backfill_boot_pass", ...res }));
  });
  // Daily at 03:00 UTC. interval ms = 24h.
  const interval = setInterval(() => {
    void backfillIntentV2().then((res) => {
      console.log(JSON.stringify({ event: "backfill_daily_pass", ...res }));
    });
  }, 24 * 60 * 60 * 1000);
  return interval;
}
