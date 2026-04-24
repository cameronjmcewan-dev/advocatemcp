import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/migrations.js";
import { vecToBlob } from "../lib/float32.js";

let testDb: Database.Database;
vi.mock("../db.js", () => ({ getDb: () => testDb }));
vi.mock("../prompts/clusterLabel.js", () => ({
  generateClusterLabel: vi.fn().mockImplementation(async (_qs: string[], opts: { fallbackClusterId?: number } | undefined) => {
    return `cluster-${opts?.fallbackClusterId ?? "x"}`;
  }),
}));

function seedQuery(slug: string, text: string, vec: Float32Array): number {
  const { lastInsertRowid } = testDb.prepare(
    `INSERT INTO queries (business_slug, query_text, response_text, query_embedding, timestamp)
     VALUES (?, ?, 'r', ?, datetime('now'))`
  ).run(slug, text, vecToBlob(vec));
  return Number(lastInsertRowid);
}

beforeEach(() => {
  testDb = new Database(":memory:");
  applyMigrations(testDb);
  testDb.prepare(
    `INSERT INTO businesses (slug, name, description, services, pricing, phone, api_key)
     VALUES ('t1', 'Test', 'd', 's', '$1', '555', 'k1')`
  ).run();
});

afterEach(() => {
  testDb.close();
  vi.restoreAllMocks();
});

describe("clusterQueries nightly (incremental)", () => {
  it("spawns a new cluster for an unembedded-cluster-id row when no clusters exist", async () => {
    const { runNightlyCluster } = await import("./clusterQueries.js");
    const v = new Float32Array(512).fill(0);
    v[0] = 1;
    seedQuery("t1", "how much for a cleaning", v);
    const res = await runNightlyCluster({ distanceThreshold: 0.3 });
    expect(res.spawned).toBe(1);
    expect(res.assigned).toBe(0);
    const clusters = testDb.prepare(`SELECT id, label, size FROM query_clusters`).all();
    expect(clusters).toHaveLength(1);
    expect((clusters[0] as { size: number }).size).toBe(1);
  });

  it("assigns a new row to an existing cluster when within threshold", async () => {
    const { runNightlyCluster } = await import("./clusterQueries.js");
    // Pre-seed a cluster
    const c = new Float32Array(512).fill(0);
    c[0] = 1;
    testDb.prepare(
      `INSERT INTO query_clusters (label, centroid, size) VALUES ('existing topic', ?, 3)`
    ).run(vecToBlob(c));
    // New query very close to that centroid
    const v = new Float32Array(512).fill(0);
    v[0] = 0.98;
    v[1] = 0.02;
    const qid = seedQuery("t1", "new query", v);
    const res = await runNightlyCluster({ distanceThreshold: 0.3 });
    expect(res.assigned).toBe(1);
    expect(res.spawned).toBe(0);
    const row = testDb.prepare(`SELECT cluster_id FROM queries WHERE id = ?`).get(qid) as { cluster_id: number | null };
    expect(row.cluster_id).not.toBeNull();
  });

  it("skips queries that are already clustered", async () => {
    const { runNightlyCluster } = await import("./clusterQueries.js");
    const c = new Float32Array(512).fill(0);
    c[0] = 1;
    testDb.prepare(
      `INSERT INTO query_clusters (label, centroid, size) VALUES ('existing', ?, 5)`
    ).run(vecToBlob(c));
    const v = new Float32Array(512).fill(0);
    v[0] = 1;
    const qid = seedQuery("t1", "q", v);
    testDb.prepare(`UPDATE queries SET cluster_id = 1 WHERE id = ?`).run(qid);
    const res = await runNightlyCluster({ distanceThreshold: 0.3 });
    expect(res.scanned).toBe(0);
  });
});

describe("clusterQueries weekly (full re-cluster)", () => {
  it("produces clusters covering all 30d queries with embeddings", async () => {
    const { runWeeklyFullCluster } = await import("./clusterQueries.js");
    // Seed 6 queries in two clear groups
    for (let i = 0; i < 3; i++) {
      const v = new Float32Array(512).fill(0);
      v[0] = 1 + i * 0.001;
      seedQuery("t1", `dental q${i}`, v);
    }
    for (let i = 0; i < 3; i++) {
      const v = new Float32Array(512).fill(0);
      v[1] = 1 + i * 0.001;
      seedQuery("t1", `plumbing q${i}`, v);
    }
    const res = await runWeeklyFullCluster({ distanceThreshold: 0.3 });
    expect(res.clusters_created_or_kept).toBeGreaterThanOrEqual(2);
    // Every seeded query should have cluster_id set
    const uncategorized = testDb.prepare(
      `SELECT COUNT(*) AS n FROM queries WHERE query_embedding IS NOT NULL AND cluster_id IS NULL`
    ).get() as { n: number };
    expect(uncategorized.n).toBe(0);
  });

  it("archives clusters that have no remaining members", async () => {
    const { runWeeklyFullCluster } = await import("./clusterQueries.js");
    // Pre-seed a cluster with no actual member queries
    const c = new Float32Array(512).fill(0);
    c[5] = 1;
    testDb.prepare(
      `INSERT INTO query_clusters (label, centroid, size) VALUES ('orphan', ?, 0)`
    ).run(vecToBlob(c));
    const v = new Float32Array(512).fill(0);
    v[0] = 1;
    seedQuery("t1", "dental", v);
    await runWeeklyFullCluster({ distanceThreshold: 0.3 });
    const orphan = testDb.prepare(`SELECT archived_at FROM query_clusters WHERE label = 'orphan'`).get() as { archived_at: string | null };
    expect(orphan.archived_at).not.toBeNull();
  });
});
