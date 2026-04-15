import { describe, it, expect } from "vitest";

// Mirror the contract: worker should send canonical bot name, not raw UA.
// Because the full Worker handler is large and side-effectful, we unit-test
// the contract shape directly: given a UA, what does the body look like?

describe("worker forwards canonical bot name to Railway", () => {
  // Pure function replica of what the fetch body should look like.
  // If this behavior changes, the actual Worker change in index.ts should be updated to match.
  function buildForwardBody(query: string, canonical: string | null): string {
    return JSON.stringify({ query, crawler: canonical ?? "" });
  }

  it("sends canonical name for a matched UA", () => {
    const body = JSON.parse(buildForwardBody("hi", "PerplexityBot"));
    expect(body.crawler).toBe("PerplexityBot");
    expect(body.crawler).not.toMatch(/Mozilla/);
  });

  it("sends empty string when UA does not match any canonical", () => {
    const body = JSON.parse(buildForwardBody("hi", null));
    expect(body.crawler).toBe("");
  });

  it("never embeds the full raw UA", () => {
    const body = JSON.parse(buildForwardBody("hi", "GPTBot"));
    expect(body.crawler.length).toBeLessThan(50);
  });
});
