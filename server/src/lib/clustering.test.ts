import { describe, it, expect } from "vitest";
import { agglomerativeCluster } from "./clustering.js";

function mkVec(arr: number[]): Float32Array {
  return new Float32Array(arr);
}

describe("agglomerativeCluster", () => {
  it("returns each point in its own cluster when threshold is strict", () => {
    const input = [
      { id: 1, vec: mkVec([1, 0]) },
      { id: 2, vec: mkVec([0, 1]) },
      { id: 3, vec: mkVec([-1, 0]) },
    ];
    const out = agglomerativeCluster(input, { distanceThreshold: 0.01 });
    expect(out).toHaveLength(3);
  });

  it("merges near-identical vectors into one cluster", () => {
    const input = [
      { id: 1, vec: mkVec([1, 0, 0]) },
      { id: 2, vec: mkVec([0.99, 0.01, 0]) },
      { id: 3, vec: mkVec([0, 1, 0]) },
    ];
    const out = agglomerativeCluster(input, { distanceThreshold: 0.3 });
    // One cluster for the two similar vectors + one for the orthogonal
    expect(out).toHaveLength(2);
    const bigCluster = out.find((c) => c.memberIds.length === 2);
    expect(bigCluster).toBeDefined();
    expect(bigCluster!.memberIds.sort()).toEqual([1, 2]);
  });

  it("handles empty input", () => {
    expect(agglomerativeCluster([], { distanceThreshold: 0.3 })).toEqual([]);
  });

  it("handles single-point input", () => {
    const out = agglomerativeCluster(
      [{ id: 42, vec: mkVec([1, 0]) }],
      { distanceThreshold: 0.3 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].memberIds).toEqual([42]);
  });

  it("invariant: every input id appears in exactly one output cluster", () => {
    // property-ish: generate 30 random unit vectors, cluster them, check coverage
    const dims = 8;
    const n = 30;
    const input = Array.from({ length: n }, (_, i) => {
      const v = new Float32Array(dims);
      for (let d = 0; d < dims; d++) v[d] = Math.random() - 0.5;
      return { id: i + 1, vec: v };
    });
    const out = agglomerativeCluster(input, { distanceThreshold: 0.4 });
    const seen = new Set<number>();
    for (const c of out) {
      for (const id of c.memberIds) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(n);
  });

  it("invariant: cluster size matches memberIds.length", () => {
    const input = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      vec: new Float32Array([Math.random(), Math.random(), Math.random()]),
    }));
    const out = agglomerativeCluster(input, { distanceThreshold: 0.3 });
    for (const c of out) {
      expect(c.size).toBe(c.memberIds.length);
    }
  });

  it("invariant: centroid equals mean of members (within float tolerance)", () => {
    const input = [
      { id: 1, vec: mkVec([2, 0, 0]) },
      { id: 2, vec: mkVec([2.02, 0, 0]) },
    ];
    const out = agglomerativeCluster(input, { distanceThreshold: 0.1 });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.centroid[0]).toBeCloseTo(2.01, 3);
    expect(c.centroid[1]).toBeCloseTo(0, 3);
    expect(c.centroid[2]).toBeCloseTo(0, 3);
  });
});
