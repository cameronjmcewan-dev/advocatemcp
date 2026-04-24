/**
 * Incremental cluster assignment used by the NIGHTLY cluster job.
 *
 * For each new query, find the nearest existing cluster centroid. If
 * within threshold, assign + update centroid incrementally. Otherwise,
 * signal the caller to spawn a new cluster.
 *
 * The nightly job never re-assigns existing queries — that only happens
 * during the weekly full re-cluster (see src/lib/clustering.ts). This
 * gives us stable cluster IDs + labels night-over-night, with the
 * weekly pass acting as drift correction.
 */

import { cosineSim } from "./float32.js";

export interface ExistingCluster {
  id: number;
  centroid: Float32Array;
  size: number;
}

export interface AssignResult {
  clusterId: number | null;   // null when spawning
  spawned: boolean;
  newCentroid: Float32Array;  // updated centroid (or the vec itself if spawning)
  newSize: number;            // updated size (or 1 if spawning)
}

export function assignIncremental(
  vec: Float32Array,
  clusters: ExistingCluster[],
  opts: { distanceThreshold: number },
): AssignResult {
  let bestId: number | null = null;
  let bestDist = Infinity;
  let bestCluster: ExistingCluster | null = null;

  for (const c of clusters) {
    const d = 1 - cosineSim(vec, c.centroid);
    if (d < bestDist) {
      bestDist = d;
      bestId = c.id;
      bestCluster = c;
    }
  }

  if (bestCluster && bestDist <= opts.distanceThreshold) {
    // Incremental centroid update: (old_mean * n + new) / (n + 1)
    const dims = vec.length;
    const newCentroid = new Float32Array(dims);
    const n = bestCluster.size;
    for (let i = 0; i < dims; i++) {
      newCentroid[i] = (bestCluster.centroid[i] * n + vec[i]) / (n + 1);
    }
    return {
      clusterId: bestId,
      spawned: false,
      newCentroid,
      newSize: n + 1,
    };
  }

  // Spawn
  const spawnCentroid = new Float32Array(vec);
  return {
    clusterId: null,
    spawned: true,
    newCentroid: spawnCentroid,
    newSize: 1,
  };
}
