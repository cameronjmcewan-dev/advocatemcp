/**
 * Backfill job: embed queries rows that are missing query_embedding.
 *
 * Mirrors backfillQueries.ts exactly: batched, budget-capped, runs on
 * boot + daily at 04:00 UTC, skipped silently when VOYAGE_API_KEY is
 * absent so unconfigured dev/test environments don't log noise.
 *
 * Cost: voyage-3.5-lite at $0.02/1M tokens, ~10 tokens per short query
 * = $0.0000002 per query. A budget of 50c/day caps at ~2.5M queries/day
 * — effectively unlimited at our scale. Budget is a circuit breaker for
 * a runaway loop, not a real ceiling.
 */

import { getDb } from "../db.js";
import { embedBatch } from "../agent/embeddings.js";
import { vecToBlob } from "../lib/float32.js";

// Env vars are read inside the function so per-run overrides (and tests)
// take effect without re-importing the module.
const COST_PER_QUERY_CENTS = 0.00002; // rough; per-batch more accurate but immaterial

export interface EmbedBackfillResult {
  scanned: number;
  filled: number;
  errors: number;
  cost_cents: number;
  budget_halted: boolean;
  skipped_no_api_key?: boolean;
}

export async function backfillEmbeddings(): Promise<EmbedBackfillResult> {
  if (!process.env.VOYAGE_API_KEY) {
    return {
      scanned: 0, filled: 0, errors: 0, cost_cents: 0,
      budget_halted: false, skipped_no_api_key: true,
    };
  }

  const result: EmbedBackfillResult = {
    scanned: 0, filled: 0, errors: 0, cost_cents: 0, budget_halted: false,
  };

  const dailyBudget = parseInt(process.env.EMBEDDINGS_DAILY_BUDGET_CENTS ?? "50", 10);
  if (dailyBudget <= 0) {
    result.budget_halted = true;
    return result;
  }

  const db = getDb();
  const batchSize = parseInt(process.env.EMBEDDINGS_BATCH_SIZE ?? "96", 10);
  const rows = db.prepare(
    `SELECT id, query_text FROM queries
      WHERE query_embedding IS NULL AND query_text IS NOT NULL
      ORDER BY id DESC
      LIMIT ?`
  ).all(batchSize) as { id: number; query_text: string }[];

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const updateStmt = db.prepare(
    `UPDATE queries SET query_embedding = COALESCE(query_embedding, ?) WHERE id = ?`
  );

  // Chunk into batches of 96 (lite tier ceiling w/ headroom). BATCH_SIZE
  // caps the outer pass, so this usually runs once.
  const CHUNK = 96;
  for (let start = 0; start < rows.length; start += CHUNK) {
    if (result.cost_cents >= dailyBudget) {
      result.budget_halted = true;
      break;
    }
    const slice = rows.slice(start, start + CHUNK);
    try {
      const vecs = await embedBatch(slice.map((r) => r.query_text));
      const tx = db.transaction(() => {
        for (let i = 0; i < slice.length; i++) {
          updateStmt.run(vecToBlob(vecs[i]), slice[i].id);
        }
      });
      tx();
      result.filled += slice.length;
      result.cost_cents += slice.length * COST_PER_QUERY_CENTS;
    } catch (err) {
      result.errors++;
      console.error(JSON.stringify({
        event: "embed_backfill_error",
        chunk_size: slice.length,
        error: String(err instanceof Error ? err.message : err),
      }));
    }
  }

  return result;
}

/**
 * Scheduler entry. Registered by bootstrap alongside startBackfillSchedule
 * + startReputationRollupSchedule. Boot-pass + daily at 04:00 UTC.
 */
export function startEmbeddingsBackfillSchedule(): NodeJS.Timer | null {
  if (!process.env.VOYAGE_API_KEY) {
    console.log(JSON.stringify({ event: "embed_backfill_skipped_no_api_key" }));
    return null;
  }
  void backfillEmbeddings().then((res) => {
    console.log(JSON.stringify({ event: "embed_backfill_boot_pass", ...res }));
  });
  const interval = setInterval(() => {
    void backfillEmbeddings().then((res) => {
      console.log(JSON.stringify({ event: "embed_backfill_daily_pass", ...res }));
    });
  }, 24 * 60 * 60 * 1000);
  return interval;
}

