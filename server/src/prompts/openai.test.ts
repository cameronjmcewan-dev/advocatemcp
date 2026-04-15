import { describe, it, expect } from "vitest";
import { openaiBlock } from "./openai.js";

describe("openaiBlock", () => {
  it("identifies as openai", () => {
    expect(openaiBlock.name).toBe("openai");
  });
  it("favors conversational tone with inline facts", () => {
    expect(openaiBlock.emphasis).toMatch(/conversational|natural|paragraph/i);
  });
  it("is non-empty", () => {
    expect(openaiBlock.emphasis.length).toBeGreaterThan(50);
  });
});
