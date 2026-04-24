/**
 * Cluster job — runs in two modes:
 *
 *   runNightlyCluster()      — incremental assignment for new queries
 *   runWeeklyFullCluster()   — drift-correcting full re-cluster over
 *                              last-30d embedded queries
 *
 * Scheduled by startClusterSchedule() alongside the other jobs. The
 * nightly run is cheap (one Haiku call per NEW cluster spawned); the
 * weekly run is heavier (O(n² log n) clustering + one Haiku call per
 * changed cluster) and runs Sunday 04:30 UTC after the backfill.
 */

import { getDb } from "../db.js";
import { blobToVec, vecToBlob, cosineSim } from "../lib/float32.js";
import { assignIncremental, type ExistingCluster } from "../lib/clustering.incremental.js";
import { agglomerativeCluster, type ClusterOutput } from "../lib/clustering.js";
import { generateClusterLabel } from "../prompts/clusterLabel.js";

export interface ClusterOpts {
  distanceThreshold: number;
}

export interface NightlyResult {
  scanned: number;
  assigned: number;
  spawned: number;
  errors: number;
}

export interface WeeklyResult {
  queries_scanned: number;
  clusters_created_or_kept: number;
  clusters_archived: number;
  errors: number;
}

function loadActiveClusters(): ExistingCluster[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, centroid, size FROM query_clusters WHERE archived_at IS NULL`
  ).all() as { id: number; centroid: Buffer; size: number }[];
  return rows.map((r) => ({ id: r.id, centroid: blobToVec(r.centroid), size: r.size }));
}

export async function runNightlyCluster(opts: ClusterOpts): Promise<NightlyResult> {
  const db = getDb();
  const result: NightlyResult = { scanned: 0, assigned: 0, spawned: 0, errors: 0 };

  const rows = db.prepare(
    `SELECT id, query_text, query_embedding FROM queries
      WHERE query_embedding IS NOT NULL AND cluster_id IS NULL
      ORDER BY id ASC`
  ).all() as { id: number; query_text: string; query_embedding: Buffer }[];

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  // Load current clusters ONCE. We mutate centroid/size locally as we
  // assign, so reading from DB again each iteration would be wasteful.
  const clusters = loadActiveClusters();

  const upsertCluster = db.prepare(
    `UPDATE query_clusters SET centroid = ?, size = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const insertCluster = db.prepare(
    `INSERT INTO query_clusters (label, centroid, size) VALUES (?, ?, 1)`
  );
  const setQueryCluster = db.prepare(`UPDATE queries SET cluster_id = ? WHERE id = ?`);

  for (const row of rows) {
    try {
      const vec = blobToVec(row.query_embedding);
      const out = assignIncremental(vec, clusters, { distanceThreshold: opts.distanceThreshold });
      if (out.spawned) {
        // Label first (async), then insert with label
        const label = await generateClusterLabel([row.query_text]);
        const insert = insertCluster.run(label, vecToBlob(out.newCentroid));
        const newId = Number(insert.lastInsertRowid);
        setQueryCluster.run(newId, row.id);
        clusters.push({ id: newId, centroid: out.newCentroid, size: 1 });
        result.spawned++;
      } else {
        upsertCluster.run(vecToBlob(out.newCentroid), out.newSize, out.clusterId!);
        setQueryCluster.run(out.clusterId, row.id);
        // Update in-memory list so subsequent assignments see the new size
        const c = clusters.find((x) => x.id === out.clusterId);
        if (c) {
          c.centroid = out.newCentroid;
          c.size = out.newSize;
        }
        result.assigned++;
      }
    } catch (err) {
      result.errors++;
      console.error(JSON.stringify({
        event: "cluster_nightly_error",
        query_id: row.id,
        error: String(err instanceof Error ? err.message : err),
      }));
    }
  }

  return result;
}

export async function runWeeklyFullCluster(opts: ClusterOpts): Promise<WeeklyResult> {
  const db = getDb();
  const result: WeeklyResult = {
    queries_scanned: 0, clusters_created_or_kept: 0, clusters_archived: 0, errors: 0,
  };

  const rows = db.prepare(
    `SELECT id, query_text, query_embedding FROM queries
      WHERE query_embedding IS NOT NULL
        AND timestamp >= datetime('now', '-30 days')`
  ).all() as { id: number; query_text: string; query_embedding: Buffer }[];

  result.queries_scanned = rows.length;
  if (rows.length === 0) return result;

  const points = rows.map((r) => ({ id: r.id, vec: blobToVec(r.query_embedding) }));
  const textById = new Map<number, string>();
  for (const r of rows) textById.set(r.id, r.query_text);

  const newClusters = agglomerativeCluster(points, { distanceThreshold: opts.distanceThreshold });

  // Match new clusters to existing by centroid similarity (≥0.9 → same).
  const existing = loadActiveClusters();
  const matchedExistingIds = new Set<number>();
  const insertStmt = db.prepare(
    `INSERT INTO query_clusters (label, centroid, size, representative_query_ids) VALUES (?, ?, ?, ?)`
  );
  const updateStmt = db.prepare(
    `UPDATE query_clusters SET centroid = ?, size = ?, representative_query_ids = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const setQueryCluster = db.prepare(`UPDATE queries SET cluster_id = ? WHERE id = ?`);
  const archiveStmt = db.prepare(
    `UPDATE query_clusters SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`
  );

  for (const nc of newClusters) {
    try {
      // Find nearest existing cluster
      let bestId: number | null = null;
      let bestSim = -Infinity;
      for (const ex of existing) {
        const s = cosineSim(nc.centroid, ex.centroid);
        if (s > bestSim) { bestSim = s; bestId = ex.id; }
      }
      const representativeIds = pickRepresentatives(nc, points);
      const repJson = JSON.stringify(representativeIds);

      if (bestId !== null && bestSim >= 0.9) {
        // Keep existing cluster id + label, update centroid/size
        updateStmt.run(vecToBlob(nc.centroid), nc.size, repJson, bestId);
        matchedExistingIds.add(bestId);
        for (const mid of nc.memberIds) setQueryCluster.run(bestId, mid);
      } else {
        // Spawn new cluster: label first, then insert
        const sampleTexts = representativeIds
          .map((id) => textById.get(id))
          .filter((t): t is string => !!t);
        const label = await generateClusterLabel(sampleTexts);
        const ins = insertStmt.run(label, vecToBlob(nc.centroid), nc.size, repJson);
        const newId = Number(ins.lastInsertRowid);
        for (const mid of nc.memberIds) setQueryCluster.run(newId, mid);
      }
      result.clusters_created_or_kept++;
    } catch (err) {
      result.errors++;
      console.error(JSON.stringify({
        event: "cluster_weekly_error",
        error: String(err instanceof Error ? err.message : err),
      }));
    }
  }

  // Archive any existing active clusters that weren't matched this pass
  for (const ex of existing) {
    if (!matchedExistingIds.has(ex.id)) {
      archiveStmt.run(ex.id);
      result.clusters_archived++;
    }
  }

  return result;
}

/**
 * Pick 3 member ids whose vectors are nearest to the cluster centroid —
 * these become the "representative_query_ids" rendered on the dashboard.
 */
function pickRepresentatives(cluster: ClusterOutput, allPoints: { id: number; vec: Float32Array }[]): number[] {
  const byId = new Map<number, Float32Array>();
  for (const p of allPoints) byId.set(p.id, p.vec);
  const scored = cluster.memberIds.map((id) => ({
    id,
    sim: cosineSim(cluster.centroid, byId.get(id)!),
  }));
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, 3).map((s) => s.id);
}

/**
 * Scheduler entry. Nightly at 04:15 UTC (after the backfill at 04:00);
 * weekly full pass Sunday at 04:30 UTC.
 */
export function startClusterSchedule(): NodeJS.Timer | null {
  if (!process.env.VOYAGE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.log(JSON.stringify({ event: "cluster_schedule_skipped", reason: "missing_api_keys" }));
    return null;
  }

  const threshold = parseFloat(process.env.CLUSTER_DISTANCE_THRESHOLD ?? "0.3");

  // Boot-pass nightly so a fresh deploy lights up immediately.
  void runNightlyCluster({ distanceThreshold: threshold }).then((res) => {
    console.log(JSON.stringify({ event: "cluster_boot_nightly", ...res }));
  });

  // Check every hour; run nightly when clock hits 04:15 and weekly when
  // clock hits Sunday 04:30. Using interval rather than a real cron
  // library keeps dep list minimal.
  const interval = setInterval(() => {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const dow = now.getUTCDay();
    if (utcH === 4 && utcM >= 15 && utcM < 30) {
      void runNightlyCluster({ distanceThreshold: threshold }).then((res) => {
        console.log(JSON.stringify({ event: "cluster_nightly_pass", ...res }));
      });
    }
    if (dow === 0 && utcH === 4 && utcM >= 30 && utcM < 45) {
      void runWeeklyFullCluster({ distanceThreshold: threshold }).then((res) => {
        console.log(JSON.stringify({ event: "cluster_weekly_pass", ...res }));
      });
    }
  }, 60 * 60 * 1000); // hourly check
  return interval;
}
