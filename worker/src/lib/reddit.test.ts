/**
 * Tests for worker/src/lib/reddit.ts
 *
 * Uses vitest's vi.stubGlobal to mock fetch — no real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchRedditMentions, RedditRateLimitError } from "./reddit.js";

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetchOk(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:      true,
    status:  200,
    headers: { get: () => null },
    json:    () => Promise.resolve(body),
  }));
}

function mockFetchStatus(status: number, headers: Record<string, string> = {}) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key] ?? null },
    json:    () => Promise.resolve({}),
  }));
}

function mockFetchNetworkError() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
}

// ── Reddit response factory ───────────────────────────────────────────────────

function makeSubmission(overrides: Record<string, unknown> = {}) {
  return {
    kind: "t3",
    data: {
      id:          "abc123",
      subreddit:   "testsubreddit",
      permalink:   "/r/testsubreddit/comments/abc123/test_title/",
      author:      "testuser",
      title:       "Test submission title",
      selftext:    "Test selftext content",
      created_utc: 1700000000,
      score:       42,
      ...overrides,
    },
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "t1",
    data: {
      id:          "xyz789",
      subreddit:   "anothersubreddit",
      permalink:   "/r/anothersubreddit/comments/abc123/test_title/xyz789/",
      author:      "commenter",
      body:        "This is a comment body",
      created_utc: 1700001000,
      score:       5,
      ...overrides,
    },
  };
}

function makeRedditResponse(children: unknown[]) {
  return { data: { children } };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("searchRedditMentions", () => {
  it("1. correct request URL and User-Agent header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(makeRedditResponse([])),
    });
    vi.stubGlobal("fetch", mockFetch);

    await searchRedditMentions({ brandKeyword: "my brand", limit: 10 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      "https://www.reddit.com/search.json?q=my%20brand&sort=new&limit=10",
    );
    expect((calledInit.headers as Record<string, string>)["User-Agent"]).toBe(
      "web:advocatemcp-authority-kit:v1",
    );
  });

  it("2. parses submission result (kind=t3) with title + selftext combined", async () => {
    mockFetchOk(makeRedditResponse([makeSubmission()]));

    const results = await searchRedditMentions({ brandKeyword: "acme" });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe("t3_abc123");
    expect(r.subreddit).toBe("testsubreddit");
    expect(r.permalink).toContain("reddit.com");
    expect(r.author).toBe("testuser");
    expect(r.text).toBe("Test submission title\n\nTest selftext content");
    expect(r.created_utc).toBe(1700000000);
    expect(r.score).toBe(42);
  });

  it("3. parses comment result (kind=t1) with body", async () => {
    mockFetchOk(makeRedditResponse([makeComment()]));

    const results = await searchRedditMentions({ brandKeyword: "acme" });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.id).toBe("t1_xyz789");
    expect(r.text).toBe("This is a comment body");
    expect(r.author).toBe("commenter");
  });

  it("4. filters out [deleted] authors and empty-text items", async () => {
    mockFetchOk(makeRedditResponse([
      makeSubmission({ author: "[deleted]" }),        // should be filtered
      makeComment({ body: "" }),                      // empty text — filtered
      makeSubmission({ selftext: "", title: "" }),    // empty combined text — filtered
      makeComment({ author: "realuser", body: "real content" }), // keep
    ]));

    const results = await searchRedditMentions({ brandKeyword: "acme" });

    expect(results).toHaveLength(1);
    expect(results[0]!.author).toBe("realuser");
  });

  it("5. 429 response throws RedditRateLimitError", async () => {
    mockFetchStatus(429, { "Retry-After": "60" });

    await expect(searchRedditMentions({ brandKeyword: "acme" })).rejects.toBeInstanceOf(
      RedditRateLimitError,
    );

    // Also verify the error carries retryAfter
    const err = await searchRedditMentions({ brandKeyword: "acme" }).catch((e) => e);
    expect(err).toBeInstanceOf(RedditRateLimitError);
    expect((err as RedditRateLimitError).retryAfter).toBe(60);
  });

  it("6. non-200 non-429 status throws 'reddit: search failed: <status>'", async () => {
    mockFetchStatus(503);

    await expect(searchRedditMentions({ brandKeyword: "acme" })).rejects.toThrow(
      "reddit: search failed: 503",
    );
  });

  it("7. empty results array → returns []", async () => {
    mockFetchOk(makeRedditResponse([]));

    const results = await searchRedditMentions({ brandKeyword: "ghost" });

    expect(results).toEqual([]);
  });

  it("8. network failure throws a descriptive error", async () => {
    mockFetchNetworkError();

    await expect(searchRedditMentions({ brandKeyword: "acme" })).rejects.toThrow(
      /reddit: search failed/,
    );
  });

  it("9. permalink prefixes https://reddit.com when relative", async () => {
    mockFetchOk(makeRedditResponse([
      makeSubmission({ permalink: "/r/sub/comments/abc/title/" }),
    ]));

    const results = await searchRedditMentions({ brandKeyword: "acme" });

    expect(results[0]!.permalink).toBe("https://reddit.com/r/sub/comments/abc/title/");
  });

  it("10. defaults limit to 25 when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(makeRedditResponse([])),
    });
    vi.stubGlobal("fetch", mockFetch);

    await searchRedditMentions({ brandKeyword: "acme" });

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toContain("limit=25");
  });
});
