import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import {
  insertAgentRequest,
  setOutcome,
  findByRelatedId,
  findByRequestId,
} from "./agentRequests.js";

describe("agentRequests repo", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("insertAgentRequest writes a row with defaults and ar_-prefixed id", () => {
    const id = insertAgentRequest(db, {
      agentId: "cursor",
      agentIdSource: "header",
      businessSlug: "acme",
      toolCalled: "query_business_agent",
      requestId: "req-1",
      latencyMs: 42,
      costCents: 1,
    });
    expect(id).toMatch(/^ar_/);
    const row = db
      .prepare("SELECT * FROM agent_requests WHERE id = ?")
      .get(id) as { outcome_signal: string; latency_ms: number };
    expect(row.outcome_signal).toBe("none");
    expect(row.latency_ms).toBe(42);
  });

  it("setOutcome updates outcome_signal and outcome_ts", () => {
    const id = insertAgentRequest(db, {
      agentId: "x",
      agentIdSource: "tool_arg",
      toolCalled: "reserve_slot",
      requestId: "r2",
      latencyMs: 1,
      costCents: 0,
      relatedId: "res_abc",
    });
    const ok = setOutcome(db, { id, outcomeSignal: "reservation_held" });
    expect(ok).toBe(true);
    const row = db
      .prepare(
        "SELECT outcome_signal, outcome_ts FROM agent_requests WHERE id=?",
      )
      .get(id) as { outcome_signal: string; outcome_ts: string | null };
    expect(row.outcome_signal).toBe("reservation_held");
    expect(row.outcome_ts).not.toBeNull();
  });

  it("setOutcome returns false when id doesn't exist", () => {
    const ok = setOutcome(db, { id: "ar_nope", outcomeSignal: "click" });
    expect(ok).toBe(false);
  });

  it("findByRelatedId returns the most recent matching row", () => {
    insertAgentRequest(db, {
      agentId: "x",
      agentIdSource: "header",
      toolCalled: "reserve_slot",
      requestId: "r3",
      latencyMs: 1,
      costCents: 0,
      relatedId: "res_xyz",
    });
    const found = findByRelatedId(db, "res_xyz");
    expect(found?.related_id).toBe("res_xyz");
  });

  it("findByRequestId returns the matching row", () => {
    insertAgentRequest(db, {
      agentId: "x",
      agentIdSource: "header",
      toolCalled: "query_business_agent",
      requestId: "req-find-me",
      latencyMs: 1,
      costCents: 0,
    });
    const found = findByRequestId(db, "req-find-me");
    expect(found?.request_id).toBe("req-find-me");
  });

  it("findByRelatedId returns undefined when no match", () => {
    expect(findByRelatedId(db, "missing")).toBeUndefined();
  });
});
