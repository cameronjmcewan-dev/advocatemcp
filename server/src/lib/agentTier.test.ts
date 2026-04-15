import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { upsertReputation } from "../repos/agentReputation.js";
import { resolveAgentTier, TIER_LIMITS } from "./agentTier.js";

describe("resolveAgentTier", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("returns 'unverified' when agentId is undefined", () => {
    expect(resolveAgentTier(db, undefined)).toBe("unverified");
  });
  it("returns 'unverified' when no reputation row exists", () => {
    expect(resolveAgentTier(db, "newcomer")).toBe("unverified");
  });
  it("returns 'known' for >=10 requests at quality >=0.1", () => {
    upsertReputation(db, {
      agent_id: "k",
      window: "7d",
      requests: 10,
      reservations_confirmed: 1,
      conversion_rate: 0.1,
      avg_cost_cents: 0,
      quality_score: 0.5,
    });
    expect(resolveAgentTier(db, "k")).toBe("known");
  });
  it("returns 'trusted' for >=100 requests at quality >=0.5", () => {
    upsertReputation(db, {
      agent_id: "t",
      window: "7d",
      requests: 100,
      reservations_confirmed: 50,
      conversion_rate: 0.5,
      avg_cost_cents: 0,
      quality_score: 1.0,
    });
    expect(resolveAgentTier(db, "t")).toBe("trusted");
  });
  it("TIER_LIMITS exposes per-minute ceilings", () => {
    expect(TIER_LIMITS.unverified).toBe(100);
    expect(TIER_LIMITS.known).toBe(250);
    expect(TIER_LIMITS.trusted).toBe(1000);
  });
});
