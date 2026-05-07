/**
 * Tests for worker/src/lib/sentimentClassifier.ts
 *
 * Uses vi.stubGlobal to mock the Anthropic API — no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifySentiment, classifySentimentBatch } from "./sentimentClassifier.js";

const FAKE_API_KEY = "sk-ant-test-key";

// ── fetch mock helpers ────────────────────────────────────────────────────────

function makeAnthropicResponse(resultRows: Array<{ index: number; label: string; score: number; theme?: string }>) {
  const json = JSON.stringify({ results: resultRows });
  return {
    ok:      true,
    status:  200,
    headers: { get: () => null },
    json:    () =>
      Promise.resolve({
        content: [{ type: "text", text: json }],
      }),
  };
}

function mockFetchOk(resultRows: Array<{ index: number; label: string; score: number; theme?: string }>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeAnthropicResponse(resultRows)));
}

function mockFetchStatus(status: number) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:      false,
    status,
    headers: { get: () => null },
    json:    () => Promise.resolve({}),
  }));
}

function mockFetchMalformedJson() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:      true,
    status:  200,
    headers: { get: () => null },
    json:    () =>
      Promise.resolve({
        content: [{ type: "text", text: "not valid json {{{{" }],
      }),
  }));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("classifySentiment", () => {
  it("1. single mention — happy path returns correct label, score, theme", async () => {
    mockFetchOk([{ index: 1, label: "positive", score: 0.8, theme: "great service" }]);

    const result = await classifySentiment("They helped me so quickly!", "acme", FAKE_API_KEY);

    expect(result.label).toBe("positive");
    expect(result.score).toBeCloseTo(0.8);
    expect(result.theme).toBe("great service");
  });
});

describe("classifySentimentBatch", () => {
  it("2. batch classification — correctly maps results back to original IDs", async () => {
    mockFetchOk([
      { index: 1, label: "positive", score: 0.7, theme: "fast delivery" },
      { index: 2, label: "negative", score: -0.6, theme: "pricing issue" },
    ]);

    const mentions = [
      { id: "reddit_abc", text: "Love this product!" },
      { id: "reddit_xyz", text: "Way too expensive." },
    ];
    const results = await classifySentimentBatch(mentions, "acme", FAKE_API_KEY);

    expect(results).toHaveLength(2);

    const first = results.find((r) => r.id === "reddit_abc")!;
    expect(first.result.label).toBe("positive");
    expect(first.result.score).toBeCloseTo(0.7);
    expect(first.result.theme).toBe("fast delivery");

    const second = results.find((r) => r.id === "reddit_xyz")!;
    expect(second.result.label).toBe("negative");
    expect(second.result.score).toBeCloseTo(-0.6);
  });

  it("3. Claude API non-200 throws 'sentiment: api failed: <status>'", async () => {
    mockFetchStatus(500);

    await expect(
      classifySentimentBatch([{ id: "m1", text: "test" }], "acme", FAKE_API_KEY),
    ).rejects.toThrow("sentiment: api failed: 500");
  });

  it("4. malformed JSON response falls back to neutral defaults", async () => {
    mockFetchMalformedJson();

    const mentions = [
      { id: "m1", text: "something positive" },
      { id: "m2", text: "something negative" },
    ];
    const results = await classifySentimentBatch(mentions, "acme", FAKE_API_KEY);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.result.label).toBe("neutral");
      expect(r.result.score).toBe(0);
    }
  });

  it("5. empty mentions array → returns []", async () => {
    // fetch should not even be called
    vi.stubGlobal("fetch", vi.fn());

    const results = await classifySentimentBatch([], "acme", FAKE_API_KEY);

    expect(results).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("6. score is clamped to -1..1", async () => {
    // Claude returns out-of-range score
    mockFetchOk([{ index: 1, label: "positive", score: 1.9, theme: "enthusiasm" }]);

    const results = await classifySentimentBatch(
      [{ id: "m1", text: "Amazing!" }],
      "acme",
      FAKE_API_KEY,
    );

    expect(results[0]!.result.score).toBeLessThanOrEqual(1);
    expect(results[0]!.result.score).toBeGreaterThanOrEqual(-1);
  });

  it("7. missing index in response falls back to neutral for that mention", async () => {
    // Claude returns only result for index 1 — index 2 is missing
    mockFetchOk([{ index: 1, label: "positive", score: 0.5 }]);

    const mentions = [
      { id: "m1", text: "Great!" },
      { id: "m2", text: "Another thing." },
    ];
    const results = await classifySentimentBatch(mentions, "acme", FAKE_API_KEY);

    expect(results[0]!.result.label).toBe("positive");
    expect(results[1]!.result.label).toBe("neutral");
    expect(results[1]!.result.score).toBe(0);
  });

  it("8. JSON wrapped in code fences is parsed correctly", async () => {
    const json = JSON.stringify({ results: [{ index: 1, label: "neutral", score: 0, theme: "misc" }] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({
        content: [{ type: "text", text: "```json\n" + json + "\n```" }],
      }),
    }));

    const results = await classifySentimentBatch(
      [{ id: "m1", text: "meh" }],
      "acme",
      FAKE_API_KEY,
    );

    expect(results[0]!.result.label).toBe("neutral");
  });
});
