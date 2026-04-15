import type Database from "better-sqlite3";

export type ReputationWindow = "7d" | "30d";

export interface AgentReputationRow {
  agent_id: string;
  window: ReputationWindow;
  requests: number;
  reservations_confirmed: number;
  conversion_rate: number;
  avg_cost_cents: number;
  quality_score: number;
  updated_at: string;
}

export function getReputation(
  db: Database.Database,
  agentId: string,
  window: ReputationWindow = "7d",
): AgentReputationRow | undefined {
  return db
    .prepare(`SELECT * FROM agent_reputation WHERE agent_id = ? AND window = ?`)
    .get(agentId, window) as AgentReputationRow | undefined;
}

export function listReputation(db: Database.Database): AgentReputationRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_reputation ORDER BY quality_score DESC, agent_id ASC`,
    )
    .all() as AgentReputationRow[];
}

export function upsertReputation(
  db: Database.Database,
  r: Omit<AgentReputationRow, "updated_at">,
): void {
  db.prepare(
    `INSERT INTO agent_reputation
       (agent_id, window, requests, reservations_confirmed, conversion_rate, avg_cost_cents, quality_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(agent_id, window) DO UPDATE SET
       requests = excluded.requests,
       reservations_confirmed = excluded.reservations_confirmed,
       conversion_rate = excluded.conversion_rate,
       avg_cost_cents = excluded.avg_cost_cents,
       quality_score = excluded.quality_score,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    r.agent_id,
    r.window,
    r.requests,
    r.reservations_confirmed,
    r.conversion_rate,
    r.avg_cost_cents,
    r.quality_score,
  );
}
