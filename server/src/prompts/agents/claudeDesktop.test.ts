import { describe, it, expect } from "vitest";
import { claudeDesktopBlock } from "./claudeDesktop.js";

describe("claudeDesktopBlock", () => {
  it("has the right name", () => {
    expect(claudeDesktopBlock.name).toBe("claude-desktop");
  });

  it("emphasizes conversational tone + short markdown", () => {
    const e = claudeDesktopBlock.emphasis.toLowerCase();
    expect(e).toMatch(/conversational|natural|chat/);
    expect(e).toMatch(/markdown|short|concise/);
  });

  it("does not contain the literal string 'TODO' or 'TBD'", () => {
    expect(claudeDesktopBlock.emphasis).not.toMatch(/TODO|TBD/);
  });
});
