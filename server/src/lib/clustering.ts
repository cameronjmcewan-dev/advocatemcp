/**
 * Pure-function agglomerative hierarchical clustering for query
 * embeddings. Cosine DISTANCE (1 - cosineSim) as metric, average-
 * linkage merge, threshold cut at `distanceThreshold` (default 0.3 →
 * cosine similarity 0.7, conservative topical grouping).
 *
 * No external deps, fully deterministic given the input order.
 *
 * Complexity: O(n² log n) via repeated nearest-pair search over a
 * distance matrix. Practical ceiling ~5k points per invocation on a
 * modern dyno. Used for the WEEKLY full re-cluster. Nightly work is
 * incremental — see src/lib/clustering.incremental.ts for that.
 */

import { cosineSim } from "./float32.js";

export interface ClusterInput {
  id: number;
  vec: Float32Array;
}

export interface ClusterOutput {
  memberIds: number[];
  size: number;
  centroid: Float32Array;
}

export interface ClusterOpts {
  distanceThreshold: number; // cosine distance; 0.3 = cosine sim 0.7
}

/** cosine distance in [0, 2] */
function dist(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSim(a, b);
}

/** average-linkage distance between two member sets */
function avgLinkage(
  membersA: number[],
  membersB: number[],
  points: ClusterInput[],
  byId: Map<number, Float32Array>,
): number {
  let total = 0;
  let n = 0;
  for (const a of membersA) {
    const va = byId.get(a)!;
    for (const b of membersB) {
      total += dist(va, byId.get(b)!);
      n++;
    }
  }
  return n === 0 ? Infinity : total / n;
}

function meanCentroid(memberIds: number[], byId: Map<number, Float32Array>): Float32Array {
  const dims = byId.get(memberIds[0])!.length;
  const out = new Float32Array(dims);
  for (const id of memberIds) {
    const v = byId.get(id)!;
    for (let i = 0; i < dims; i++) out[i] += v[i];
  }
  for (let i = 0; i < dims; i++) out[i] /= memberIds.length;
  return out;
}

export function agglomerativeCluster(
  points: ClusterInput[],
  opts: ClusterOpts,
): ClusterOutput[] {
  if (points.length === 0) return [];

  const byId = new Map<number, Float32Array>();
  for (const p of points) byId.set(p.id, p.vec);

  // Start with each point as its own cluster
  let clusters: number[][] = points.map((p) => [p.id]);

  // Repeated nearest-pair merges until the closest pair exceeds threshold
  while (clusters.length > 1) {
    let bestI = -1, bestJ = -1, bestD = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = avgLinkage(clusters[i], clusters[j], points, byId);
        if (d < bestD) {
          bestD = d;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestD > opts.distanceThreshold) break;
    // Merge bestJ into bestI, drop bestJ
    const merged = [...clusters[bestI], ...clusters[bestJ]];
    clusters = [
      ...clusters.slice(0, bestI),
      merged,
      ...clusters.slice(bestI + 1, bestJ),
      ...clusters.slice(bestJ + 1),
    ];
  }

  return clusters.map((memberIds) => ({
    memberIds,
    size: memberIds.length,
    centroid: meanCentroid(memberIds, byId),
  }));
}
