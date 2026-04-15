import { describe, it, expect } from "vitest";
import { gptAgentBlock } from "./gptAgent.js";

describe("gptAgentBlock", () => {
  it("has the right name", () => {
    expect(gptAgentBlock.name).toBe("gpt-agent");
  });

  it("emphasizes function-calling / tool-orchestration friendliness", () => {
    const e = gptAgentBlock.emphasis.toLowerCase();
    expect(e).toMatch(/function|tool|action|orchestrat|next-step/);
  });

  it("mentions explicit next steps", () => {
    expect(gptAgentBlock.emphasis.toLowerCase()).toMatch(/next step|action|call/);
  });
});
