import { describe, it, expect } from "vitest";
import { trainingBlock } from "./training.js";

describe("trainingBlock", () => {
  it("identifies as training", () => {
    expect(trainingBlock.name).toBe("training");
  });
  it("emphasizes factual baseline and provenance", () => {
    expect(trainingBlock.emphasis).toMatch(/fact|provenance|verifiable/i);
  });
  it("is non-empty", () => {
    expect(trainingBlock.emphasis.length).toBeGreaterThan(50);
  });
});
