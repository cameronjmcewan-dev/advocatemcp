import type Database from "better-sqlite3";
import {
  upsertReputation,
  type ReputationWindow,
} from "../repos/agentReputation.js";

const WINDOW_DAYS: Record<ReputationWindow, number> = { "7d": 7, "30d": 30 };

interface AggregateRow {
  agent_id: string;
  requests: number;
  reservations_confirmed: number;
  avg_cost_cents: number;
}

/**
 * Recompute agent_reputation from agent_requests for both windows.
 * Idempotent — safe to run multiple times. Reads agent_requests, writes
 * agent_reputation. v1 quality_score: min(1.0, conversion_rate * 5).
 */
export function runReputationRollup(db: Database.Database): void {
  for (const window of ["7d", "30d"] as ReputationWindow[]) {
    const days = WINDOW_DAYS[window];
    const rows = db
      .prepare(
        `SELECT
           agent_id,
           COUNT(*) AS requests,
           SUM(CASE WHEN outcome_signal = 'reservation_confirmed' THEN 1 ELSE 0 END) AS reservations_confirmed,
           COALESCE(AVG(cost_cents), 0) AS avg_cost_cents
         FROM agent_requests
         WHERE timestamp > datetime('now', ?)
         GROUP BY agent_id`,
      )
      .all(`-${days} days`) as AggregateRow[];

    for (const row of rows) {
      const conversionRate =
        row.requests > 0 ? row.reservations_confirmed / row.requests : 0;
      const qualityScore = Math.min(1.0, conversionRate * 5);
      upsertReputation(db, {
        agent_id: row.agent_id,
        window,
        requests: row.requests,
        reservations_confirmed: row.reservations_confirmed,
        conversion_rate: conversionRate,
        avg_cost_cents: row.avg_cost_cents,
        quality_score: qualityScore,
      });
    }
  }
}

let _interval: NodeJS.Timeout | null = null;

/**
 * Schedule the rollup to run on boot and every `intervalMs` thereafter.
 * Idempotent — calling twice is a no-op. `unref()` on the timer so test
 * suites don't hang waiting for it. Errors are caught and logged so the
 * job never crashes the process.
 */
export function startReputationRollupSchedule(
  db: Database.Database,
  intervalMs = 15 * 60 * 1000,
): void {
  if (_interval) return;
  // Run once on boot so /admin/agents has data immediately.
  try {
    runReputationRollup(db);
  } catch (e) {
    console.error("[rollup] boot run failed", e);
  }
  _interval = setInterval(() => {
    try {
      runReputationRollup(db);
    } catch (e) {
      console.error("[rollup] tick failed", e);
    }
  }, intervalMs);
  _interval.unref();
}

export function stopReputationRollupSchedule(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
