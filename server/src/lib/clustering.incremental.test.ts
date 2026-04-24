import { describe, it, expect } from "vitest";
import { assignIncremental } from "./clustering.incremental.js";

function vec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("assignIncremental", () => {
  it("assigns to nearest existing cluster when within threshold", () => {
    const clusters = [
      { id: 1, centroid: vec([1, 0, 0]), size: 4 },
      { id: 2, centroid: vec([0, 1, 0]), size: 3 },
    ];
    const out = assignIncremental(vec([0.95, 0.05, 0]), clusters, { distanceThreshold: 0.3 });
    expect(out.clusterId).toBe(1);
    expect(out.spawned).toBe(false);
    // Centroid should shift slightly toward the new point
    expect(out.newCentroid[0]).toBeCloseTo((1 * 4 + 0.95) / 5, 4);
  });

  it("spawns a new cluster when nearest existing is beyond threshold", () => {
    const clusters = [
      { id: 1, centroid: vec([1, 0, 0]), size: 4 },
    ];
    const out = assignIncremental(vec([0, 0, 1]), clusters, { distanceThreshold: 0.3 });
    expect(out.clusterId).toBeNull();
    expect(out.spawned).toBe(true);
    expect(out.newCentroid[2]).toBe(1);
  });

  it("spawns when cluster list is empty", () => {
    const out = assignIncremental(vec([1, 0]), [], { distanceThreshold: 0.3 });
    expect(out.spawned).toBe(true);
    expect(out.clusterId).toBeNull();
  });

  it("updated size is old + 1 when assigned", () => {
    const clusters = [{ id: 5, centroid: vec([1, 0]), size: 10 }];
    const out = assignIncremental(vec([0.98, 0.01]), clusters, { distanceThreshold: 0.3 });
    expect(out.spawned).toBe(false);
    expect(out.newSize).toBe(11);
  });
});
