import { describe, it, expect } from "vitest";
import { claudeBlock } from "./claude.js";

describe("claudeBlock", () => {
  it("identifies as claude", () => {
    expect(claudeBlock.name).toBe("claude");
  });
  it("instructs clean markdown structure", () => {
    expect(claudeBlock.emphasis).toMatch(/markdown|heading|H2/i);
  });
  it("is non-empty", () => {
    expect(claudeBlock.emphasis.length).toBeGreaterThan(50);
  });
});
