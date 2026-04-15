import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { insertAgentRequest, setOutcome } from "../repos/agentRequests.js";
import { runReputationRollup } from "./reputationRollup.js";

interface RepRow {
  requests: number;
  reservations_confirmed: number;
  conversion_rate: number;
  quality_score: number;
}

function seed(
  db: Database.Database,
  agent: string,
  total: number,
  confirmed: number,
) {
  for (let i = 0; i < total; i++) {
    const id = insertAgentRequest(db, {
      agentId: agent,
      agentIdSource: "header",
      toolCalled: "reserve_slot",
      requestId: `r-${agent}-${i}`,
      latencyMs: 50,
      costCents: 0,
    });
    if (i < confirmed) {
      setOutcome(db, { id, outcomeSignal: "reservation_confirmed" });
    }
  }
}

describe("runReputationRollup", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("computes per-agent 7d row with conversion_rate and quality_score", () => {
    seed(db, "cursor", 10, 2); // 20% conversion → quality 1.0
    seed(db, "claude-desktop", 10, 0); // 0% conversion → quality 0
    runReputationRollup(db);
    const cursor = db
      .prepare(
        "SELECT requests, reservations_confirmed, conversion_rate, quality_score FROM agent_reputation WHERE agent_id='cursor' AND window='7d'",
      )
      .get() as RepRow;
    const claude = db
      .prepare(
        "SELECT requests, reservations_confirmed, conversion_rate, quality_score FROM agent_reputation WHERE agent_id='claude-desktop' AND window='7d'",
      )
      .get() as RepRow;
    expect(cursor.requests).toBe(10);
    expect(cursor.reservations_confirmed).toBe(2);
    expect(cursor.conversion_rate).toBeCloseTo(0.2, 5);
    expect(cursor.quality_score).toBeCloseTo(1.0, 5);
    expect(claude.quality_score).toBe(0);
  });

  it("upserts in place — running twice doesn't duplicate", () => {
    seed(db, "x", 5, 1);
    runReputationRollup(db);
    runReputationRollup(db);
    const rows = db
      .prepare(
        "SELECT COUNT(*) c FROM agent_reputation WHERE agent_id='x'",
      )
      .get() as { c: number };
    expect(rows.c).toBe(2); // 7d + 30d, never duplicated
  });

  it("ignores agent_requests older than the window", () => {
    insertAgentRequest(db, {
      agentId: "old",
      agentIdSource: "header",
      toolCalled: "x",
      requestId: "r-old",
      latencyMs: 1,
      costCents: 0,
    });
    db.prepare(
      "UPDATE agent_requests SET timestamp = '2020-01-01' WHERE agent_id='old'",
    ).run();
    runReputationRollup(db);
    const row = db
      .prepare(
        "SELECT requests FROM agent_reputation WHERE agent_id='old' AND window='7d'",
      )
      .get() as { requests: number } | undefined;
    expect(row?.requests ?? 0).toBe(0);
  });
});
