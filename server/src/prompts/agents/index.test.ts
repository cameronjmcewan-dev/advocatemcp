import { describe, it, expect } from "vitest";
import { getAgentPromptBlock, KNOWN_AGENTS } from "./index.js";

describe("getAgentPromptBlock dispatch", () => {
  it("returns default block for null", () => {
    expect(getAgentPromptBlock(null).name).toBe("default");
  });

  it("returns default block for empty string", () => {
    expect(getAgentPromptBlock("").name).toBe("default");
  });

  it("returns default block for unknown agent id", () => {
    expect(getAgentPromptBlock("some-random-agent").name).toBe("default");
  });

  it("dispatches 'claude-desktop' to claude-desktop block", () => {
    expect(getAgentPromptBlock("claude-desktop").name).toBe("claude-desktop");
  });

  it("dispatches 'cursor' to cursor block", () => {
    expect(getAgentPromptBlock("cursor").name).toBe("cursor");
  });

  it("dispatches 'gpt-agent' to gpt-agent block", () => {
    expect(getAgentPromptBlock("gpt-agent").name).toBe("gpt-agent");
  });

  it("is case-insensitive", () => {
    expect(getAgentPromptBlock("Claude-Desktop").name).toBe("claude-desktop");
    expect(getAgentPromptBlock("CURSOR").name).toBe("cursor");
  });

  it("KNOWN_AGENTS lists every dispatched id", () => {
    expect(KNOWN_AGENTS).toContain("claude-desktop");
    expect(KNOWN_AGENTS).toContain("cursor");
    expect(KNOWN_AGENTS).toContain("gpt-agent");
  });

  it("every KNOWN_AGENTS entry resolves to a non-default block", () => {
    for (const id of KNOWN_AGENTS) {
      expect(getAgentPromptBlock(id).name).not.toBe("default");
    }
  });
});
