import { describe, it, expect, vi, beforeEach } from "vitest";

describe("callClaude — thin Anthropic wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  it("returns the concatenated text of the assistant response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hello" }] }) };
      },
    }));
    const { callClaude } = await import("./anthropic.js");
    const out = await callClaude({ system: "s", user: "u", maxTokens: 50 });
    expect(out).toBe("hello");
  });

  it("returns null on SDK error (never throws)", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("429")) };
      },
    }));
    const { callClaude } = await import("./anthropic.js");
    const out = await callClaude({ system: "s", user: "u", maxTokens: 50 });
    expect(out).toBeNull();
  });
});
