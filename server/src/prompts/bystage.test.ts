import { describe, it, expect } from "vitest";
import { getStagePromptBlock } from "./bystage.js";

describe("getStagePromptBlock", () => {
  it("returns browsing block for 'browsing'", () => {
    const b = getStagePromptBlock("browsing");
    expect(b.name).toBe("browsing");
    expect(b.emphasis).toMatch(/short|summary|skim/i);
  });

  it("returns comparing block for 'comparing'", () => {
    const b = getStagePromptBlock("comparing");
    expect(b.name).toBe("comparing");
    expect(b.emphasis).toMatch(/compar|differen|alternativ/i);
  });

  it("returns committing block for 'committing'", () => {
    const b = getStagePromptBlock("committing");
    expect(b.name).toBe("committing");
    expect(b.emphasis).toMatch(/price|book|reserv|next step/i);
  });

  it("returns browsing block for null/undefined (safe default)", () => {
    expect(getStagePromptBlock(null).name).toBe("browsing");
    expect(getStagePromptBlock(undefined).name).toBe("browsing");
  });

  it("each stage returns a distinct emphasis string", () => {
    const a = getStagePromptBlock("browsing").emphasis;
    const b = getStagePromptBlock("comparing").emphasis;
    const c = getStagePromptBlock("committing").emphasis;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
