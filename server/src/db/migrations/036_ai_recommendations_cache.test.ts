import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../migrations.js";

describe("migration 036 — businesses.last_ai_recommendations_json", () => {
  it("adds the nullable TEXT column to businesses", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string; notnull: number; type: string; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === "last_ai_recommendations_json");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);             // nullable
    expect(col!.type).toBe("TEXT");
    expect(col!.dflt_value).toBeNull();        // no default → existing rows stay NULL
  });

  it("accepts NULL on insert (backward compat — pre-migration tenants)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const ins = () => db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key)
      VALUES ('rec1','Rec Tenant','desc','services','k')
    `).run();
    expect(ins).not.toThrow();
    const row = db.prepare(
      "SELECT last_ai_recommendations_json FROM businesses WHERE slug = 'rec1'",
    ).get() as { last_ai_recommendations_json: string | null };
    expect(row.last_ai_recommendations_json).toBeNull();
  });

  it("accepts a JSON-encoded blob string", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const blob = JSON.stringify({
      profile_hash:        "sha256:profile-deadbeef",
      score_hash:          "sha256:score-cafebabe",
      analytics_window_id: "sha256:window-20260430",
      generated_at:        "2026-04-30T20:00:00.000Z",
      recommendations: [
        {
          id:       "rec-001",
          title:    "Add pricing ranges",
          body:     "Tenants in your category typically include hourly or per-project ranges.",
          priority: "high",
          impact:   "Lifts pricing-led intent capture",
        },
      ],
      model:      "claude-sonnet-4-6",
      cost_cents: 8,
      trial_id:   "01J0000000000000000000000",
    });
    db.prepare(`
      INSERT INTO businesses (slug, name, description, services, api_key, last_ai_recommendations_json)
      VALUES ('rec2','Rec Two','desc','services','k', ?)
    `).run(blob);
    const row = db.prepare(
      "SELECT last_ai_recommendations_json FROM businesses WHERE slug = 'rec2'",
    ).get() as { last_ai_recommendations_json: string };
    expect(row.last_ai_recommendations_json).toBe(blob);
    const parsed = JSON.parse(row.last_ai_recommendations_json) as { recommendations: Array<{ priority: string }> };
    expect(parsed.recommendations[0].priority).toBe("high");
  });

  it("is idempotent — applyMigrations called twice does not throw", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
    // Column still present after second apply
    const cols = db.prepare("PRAGMA table_info(businesses)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "last_ai_recommendations_json")).toBe(true);
  });
});
