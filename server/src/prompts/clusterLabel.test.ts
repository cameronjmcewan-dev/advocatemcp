import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function (this: { messages: { create: typeof mockCreate } }) {
    this.messages = { create: mockCreate };
  }),
}));

describe("cluster label prompt", () => {
  it("generateClusterLabel() calls Haiku and returns a stripped label", async () => {
    const { generateClusterLabel } = await import("./clusterLabel.js");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "dental cleaning pricing" }],
    });
    const label = await generateClusterLabel([
      "how much for a dental cleaning",
      "cost of teeth cleaning",
      "dentist cleaning price",
    ]);
    expect(label).toBe("dental cleaning pricing");
    // Verify the prompt includes the PII-strip rule
    const args = mockCreate.mock.calls[0][0];
    const sys = args.system?.[0]?.text ?? args.system;
    expect(String(sys)).toMatch(/no business names/i);
    expect(String(sys)).toMatch(/strip/i);
  });

  it("falls back to 'topic N' on Haiku failure", async () => {
    const { generateClusterLabel } = await import("./clusterLabel.js");
    mockCreate.mockRejectedValueOnce(new Error("API down"));
    const label = await generateClusterLabel(["q1", "q2"], { fallbackClusterId: 42 });
    expect(label).toBe("topic 42");
  });

  it("clamps label length to ~60 chars and lowercases", async () => {
    const { generateClusterLabel } = await import("./clusterLabel.js");
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "VERY LONG LABEL THAT EXCEEDS SIXTY CHARACTERS AND HAS WAY TOO MUCH TEXT IN IT" }],
    });
    const label = await generateClusterLabel(["q1"]);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toBe(label.toLowerCase());
  });
});
