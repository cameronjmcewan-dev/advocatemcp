import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import {
  overviewStats,
  topQueries,
  profileGaps,
  trendsByIndustry,
  topClusters,
  embeddingsHealth,
} from "./insights.js";

/* Seed helper — inserts a handful of businesses and queries at varied
   timestamps / industries / intents so each insights function has real
   rows to chew on. Kept intentionally small so test output is easy to
   read when expectations shift. */
function seed(db: Database.Database) {
  const now = Date.now();
  const dayAgo = (n: number) => new Date(now - n * 86400000).toISOString().replace("T", " ").slice(0, 19);

  const bizStmt = db.prepare(
    `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key, category)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // biz 1: healthcare with empty pricing → pricing-intent gap
  bizStmt.run("dental1", "Pediatric Dental", "d", "s", null, "555", "k1", "Pediatric Dental Practice");
  // biz 2: home services with populated pricing → no pricing gap
  bizStmt.run("plumb1",  "Quick Plumb", "d", "s", "$150 flat call", "555", "k2", "Commercial Plumbing");
  // biz 3: florist, empty phone → contact-intent gap
  bizStmt.run("bloom1",  "Bloom & Stem", "d", "s", "$40-120", null, "k3", "Florist");

  const qStmt = db.prepare(
    `INSERT INTO queries (
       business_slug, crawler_agent, query_text, response_text,
       intent, intent_v2, request_id, agent_id, stage,
       tokens_in, tokens_out, cost_cents, model,
       geo_country, geo_region, geo_city, industry_code, outcome, timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Dental: 5 pricing queries, field empty → big gap
  for (let i = 0; i < 5; i++) {
    qStmt.run("dental1", "Perplexity", "how much for cleaning", "resp", "affordable", "pricing", "r" + i, null, null, 100, 50, 2, "claude-sonnet-4-6", "US", "TX", "Austin", "healthcare", "none", dayAgo(i));
  }
  // Dental: 1 hours query
  qStmt.run("dental1", "ChatGPT", "open saturday", "resp", "general", "hours", "rh", null, null, 80, 30, 1, "claude-sonnet-4-6", "US", "TX", "Austin", "healthcare", "none", dayAgo(2));

  // Plumb: 3 pricing queries — but pricing IS populated, so no gap
  for (let i = 0; i < 3; i++) {
    qStmt.run("plumb1", "Claude", "cost of drain unclog", "resp", "affordable", "pricing", "p" + i, null, null, 100, 50, 2, "claude-sonnet-4-6", "US", "TX", "Austin", "home_services", "none", dayAgo(i));
  }

  // Bloom: 4 contact queries with phone empty → contact gap
  for (let i = 0; i < 4; i++) {
    qStmt.run("bloom1", "Perplexity", "how do i call you", "resp", "general", "contact", "b" + i, null, null, 90, 40, 2, "claude-sonnet-4-6", "US", "TX", "Austin", "events", "none", dayAgo(i));
  }
  qStmt.run("bloom1", "ChatGPT", "flower arrangement cost", "resp", "affordable", "pricing", "bp", null, null, 90, 40, 2, "claude-sonnet-4-6", "US", "TX", "Austin", "events", "click", dayAgo(5));

  // One old query (40 days) to verify 30-day windows filter it out.
  qStmt.run("dental1", "Perplexity", "old query", "resp", "general", null, "old1", null, null, 100, 50, 2, "claude-sonnet-4-6", "US", "TX", "Austin", "healthcare", "none", dayAgo(40));
}

describe("insights SQL helpers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    seed(db);
  });

  describe("overviewStats", () => {
    it("reports totals, 30d window, and Layer 1 coverage %", () => {
      const o = overviewStats(db);
      // Seed: 5 dental pricing + 1 dental hours + 3 plumb pricing +
      //       4 bloom contact + 1 bloom pricing + 1 old dental = 15.
      expect(o.total_queries).toBe(15);
      expect(o.queries_last_30d).toBe(14);         // excludes the 40-day old row
      expect(o.queries_with_intent_v2).toBe(14);   // the 40-day-old row has intent_v2 NULL
      expect(o.queries_with_geo).toBe(15);
      expect(o.queries_with_industry).toBe(15);
      expect(o.unique_tenants_active_30d).toBe(3);
    });

    it("surfaces the top crawler + top model", () => {
      const o = overviewStats(db);
      expect(o.top_crawler?.name).toBe("Perplexity");
      expect(o.top_model?.name).toBe("claude-sonnet-4-6");
    });

    it("sums cost_cents over the 30d window", () => {
      const o = overviewStats(db);
      // Sum of cost_cents for last-30-days rows. Tightly bounded — if a
      // future seed tweaks amounts this test catches the drift.
      expect(o.total_cost_cents_30d).toBeGreaterThan(0);
      expect(o.total_cost_cents_30d).toBeLessThan(100);
    });
  });

  describe("topQueries", () => {
    it("groups by normalized query_text and returns highest-frequency first", () => {
      const rows = topQueries(db, { limit: 5, days: 30 });
      // 5 dental pricing queries should top the list.
      expect(rows[0].query_text).toBe("how much for cleaning");
      expect(rows[0].count).toBe(5);
      // Tenant dedup: all 5 from dental1 so unique_tenants = 1.
      expect(rows[0].unique_tenants).toBe(1);
    });

    it("respects the days window", () => {
      const rows = topQueries(db, { limit: 50, days: 30 });
      // The 40-day-old row should not appear.
      expect(rows.every((r) => r.query_text !== "old query")).toBe(true);
    });

    it("ignores blank / whitespace-only queries", () => {
      db.prepare(`INSERT INTO queries (business_slug, query_text, response_text) VALUES ('dental1', '   ', 'r')`).run();
      const rows = topQueries(db, { limit: 50, days: 30 });
      expect(rows.every((r) => r.query_text.trim().length > 0)).toBe(true);
    });
  });

  describe("profileGaps", () => {
    it("flags dental pricing gap (5 questions, empty pricing field)", () => {
      const gaps = profileGaps(db);
      const dental = gaps.find((g) => g.slug === "dental1");
      expect(dental).toBeDefined();
      expect(dental!.top_missing_intent).toBe("pricing");
      expect(dental!.missing_count).toBe(5);
      expect(dental!.missing_field).toMatch(/pricing/);
    });

    it("flags bloom contact gap (4 questions, empty phone)", () => {
      const gaps = profileGaps(db);
      const bloom = gaps.find((g) => g.slug === "bloom1");
      expect(bloom).toBeDefined();
      expect(bloom!.top_missing_intent).toBe("contact");
      expect(bloom!.missing_count).toBe(4);
    });

    it("does NOT flag a tenant whose top-asked intent field is populated", () => {
      const gaps = profileGaps(db);
      // plumb1's top intent is pricing but their pricing field is populated,
      // so they shouldn't show up in the gap list.
      expect(gaps.find((g) => g.slug === "plumb1")).toBeUndefined();
    });

    it("sorts gaps by missing_count descending", () => {
      const gaps = profileGaps(db);
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i - 1].missing_count).toBeGreaterThanOrEqual(gaps[i].missing_count);
      }
    });
  });

  describe("trendsByIndustry", () => {
    it("returns rows bucketed by (industry_code, day)", () => {
      const rows = trendsByIndustry(db, { days: 30 });
      expect(rows.length).toBeGreaterThan(0);
      // Every row has the three counters.
      for (const r of rows) {
        expect(typeof r.query_count).toBe("number");
        expect(typeof r.unique_tenants).toBe("number");
        expect(typeof r.avg_cost_cents).toBe("number");
      }
    });

    it("segments by industry_code", () => {
      const rows = trendsByIndustry(db, { days: 30 });
      const industries = new Set(rows.map((r) => r.industry_code));
      expect(industries.has("healthcare")).toBe(true);
      expect(industries.has("home_services")).toBe(true);
      expect(industries.has("events")).toBe(true);
    });

    it("respects the days window", () => {
      // 40-day old healthcare query should not appear in a 14-day view.
      const rows14 = trendsByIndustry(db, { days: 14 });
      const totalIn14 = rows14.reduce((s, r) => s + r.query_count, 0);
      const rowsAll = trendsByIndustry(db, { days: 60 });
      const totalIn60 = rowsAll.reduce((s, r) => s + r.query_count, 0);
      expect(totalIn14).toBeLessThan(totalIn60);
    });
  });

  describe("topClusters", () => {
    it("returns clusters sorted by query count with representative queries", () => {
      const c = new Float32Array(512).fill(0);
      c[0] = 1;
      const centroid = Buffer.from(c.buffer);
      db.prepare(
        `INSERT INTO query_clusters (id, label, centroid, size, representative_query_ids)
         VALUES (1, 'dental pricing', ?, 5, '[1,2,3]')`
      ).run(centroid);
      db.prepare(
        `INSERT INTO query_clusters (id, label, centroid, size, representative_query_ids)
         VALUES (2, 'hours query', ?, 2, '[4]')`
      ).run(centroid);
      // Seed 5 dental queries, 2 hours queries, all last-30d
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO queries (business_slug, query_text, response_text, cluster_id, timestamp)
           VALUES ('dental1', 'q' || ?, 'r', 1, datetime('now'))`
        ).run(i);
      }
      for (let i = 0; i < 2; i++) {
        db.prepare(
          `INSERT INTO queries (business_slug, query_text, response_text, cluster_id, timestamp)
           VALUES ('dental1', 'h' || ?, 'r', 2, datetime('now'))`
        ).run(i);
      }
      const rows = topClusters(db, { limit: 10, days: 30 });
      expect(rows.length).toBe(2);
      expect(rows[0].label).toBe("dental pricing");
      expect(rows[0].count).toBe(5);
      expect(rows[0].representative_query_ids).toEqual([1, 2, 3]);
    });

    it("ignores archived clusters", () => {
      const c = new Float32Array(512).fill(0);
      const centroid = Buffer.from(c.buffer);
      db.prepare(
        `INSERT INTO query_clusters (id, label, centroid, size, archived_at)
         VALUES (1, 'archived', ?, 5, datetime('now'))`
      ).run(centroid);
      db.prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, cluster_id, timestamp)
         VALUES ('dental1', 'q', 'r', 1, datetime('now'))`
      ).run();
      const rows = topClusters(db, { limit: 10, days: 30 });
      expect(rows).toHaveLength(0);
    });
  });

  describe("embeddingsHealth", () => {
    it("reports coverage % for last 7d and 30d", () => {
      // Start from a clean queries table so the coverage ratio is bounded
      // by exactly the two rows we insert below (1 embedded, 1 not).
      db.prepare(`DELETE FROM queries`).run();
      db.prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, timestamp)
         VALUES ('dental1', 'q', 'r', datetime('now'))`
      ).run();
      const embed = Buffer.from(new Float32Array(512).buffer);
      db.prepare(
        `INSERT INTO queries (business_slug, query_text, response_text, query_embedding, timestamp)
         VALUES ('dental1', 'q', 'r', ?, datetime('now'))`
      ).run(embed);
      const h = embeddingsHealth(db);
      expect(h.coverage_last_7d_pct).toBeCloseTo(0.5, 2);
      expect(h.total_clusters_active).toBe(0);
      expect(h.backfill_remaining).toBeGreaterThanOrEqual(1);
    });
  });
});
