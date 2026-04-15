import type Database from "better-sqlite3";
import { generateUlid } from "../lib/requestId.js";

export type AgentIdSource = "oauth" | "header" | "tool_arg" | "inferred";
export type OutcomeSignal =
  | "none"
  | "click"
  | "reservation_held"
  | "reservation_confirmed"
  | "handoff_completed"
  | "error";

export interface AgentRequestInsert {
  agentId: string;
  agentIdSource: AgentIdSource;
  businessSlug?: string | null;
  toolCalled: string;
  requestId?: string | null;
  latencyMs: number;
  costCents: number;
  relatedId?: string | null;
  outcomeSignal?: OutcomeSignal;
}

export interface AgentRequestRow {
  id: string;
  agent_id: string;
  agent_id_source: AgentIdSource;
  business_slug: string | null;
  tool_called: string;
  request_id: string | null;
  timestamp: string;
  latency_ms: number;
  cost_cents: number;
  outcome_signal: OutcomeSignal;
  outcome_ts: string | null;
  related_id: string | null;
}

export function insertAgentRequest(
  db: Database.Database,
  r: AgentRequestInsert,
): string {
  const id = `ar_${generateUlid()}`;
  db.prepare(
    `INSERT INTO agent_requests
     (id, agent_id, agent_id_source, business_slug, tool_called, request_id,
      latency_ms, cost_cents, outcome_signal, related_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    r.agentId,
    r.agentIdSource,
    r.businessSlug ?? null,
    r.toolCalled,
    r.requestId ?? null,
    r.latencyMs,
    r.costCents,
    r.outcomeSignal ?? "none",
    r.relatedId ?? null,
  );
  return id;
}

export function setOutcome(
  db: Database.Database,
  args: { id: string; outcomeSignal: OutcomeSignal },
): boolean {
  const result = db
    .prepare(
      `UPDATE agent_requests
          SET outcome_signal = ?, outcome_ts = CURRENT_TIMESTAMP
        WHERE id = ?`,
    )
    .run(args.outcomeSignal, args.id);
  return result.changes > 0;
}

/**
 * Set both outcome_signal and related_id atomically. Used by reserve_slot
 * after the reservation row is created — we want to stamp 'reservation_held'
 * AND record reservation_id as related_id in one UPDATE.
 */
export function setOutcomeAndRelated(
  db: Database.Database,
  args: { id: string; outcomeSignal: OutcomeSignal; relatedId: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE agent_requests
          SET outcome_signal = ?, outcome_ts = CURRENT_TIMESTAMP, related_id = ?
        WHERE id = ?`,
    )
    .run(args.outcomeSignal, args.relatedId, args.id);
  return result.changes > 0;
}

export function findByRelatedId(
  db: Database.Database,
  relatedId: string,
): AgentRequestRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_requests WHERE related_id = ? ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(relatedId) as AgentRequestRow | undefined;
}

export function findByRequestId(
  db: Database.Database,
  requestId: string,
): AgentRequestRow | undefined {
  return db
    .prepare(
      `SELECT * FROM agent_requests WHERE request_id = ? ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(requestId) as AgentRequestRow | undefined;
}
