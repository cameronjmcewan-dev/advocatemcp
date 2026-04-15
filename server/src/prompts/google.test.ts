import { describe, it, expect } from "vitest";
import { googleBlock } from "./google.js";

describe("googleBlock", () => {
  it("identifies as google", () => {
    expect(googleBlock.name).toBe("google");
  });
  it("prioritizes SERP-snippet density", () => {
    expect(googleBlock.emphasis).toMatch(/snippet|first sentence|concise|160/i);
  });
  it("is non-empty", () => {
    expect(googleBlock.emphasis.length).toBeGreaterThan(50);
  });
});
