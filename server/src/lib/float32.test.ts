import { describe, it, expect } from "vitest";
import { vecToBlob, blobToVec, cosineSim } from "./float32.js";

describe("float32 blob helpers", () => {
  it("round-trips a Float32Array through BLOB encoding", () => {
    const v = new Float32Array([0.1, -0.5, 1.25, 0]);
    const blob = vecToBlob(v);
    expect(blob).toBeInstanceOf(Buffer);
    expect(blob.length).toBe(4 * 4);
    const decoded = blobToVec(blob);
    expect(decoded).toBeInstanceOf(Float32Array);
    expect(decoded.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(decoded[i]).toBeCloseTo(v[i], 5);
    }
  });

  it("cosineSim returns 1 for identical vectors", () => {
    const v = new Float32Array([0.3, 0.4, 0.5]);
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  it("cosineSim returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(0, 5);
  });

  it("cosineSim returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(-1, 5);
  });

  it("cosineSim guards against zero-magnitude input", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSim(a, b)).toBe(0);
  });
});
