import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { perplexitySearch } from "./perplexity.js";

describe("perplexitySearch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.PERPLEXITY_API_KEY = "pplx-test-key"; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PERPLEXITY_API_KEY;
    vi.restoreAllMocks();
  });

  it("returns citations array from Perplexity response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          citations: ["https://a.com", "https://b.com"],
          choices: [{ message: { content: "answer" } }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await perplexitySearch("best plumber Boise");
    expect(result.citations).toEqual(["https://a.com", "https://b.com"]);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("returns empty citations when response omits them", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await perplexitySearch("q");
    expect(result.citations).toEqual([]);
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(perplexitySearch("q")).rejects.toThrow(/500/);
  });

  it("throws if PERPLEXITY_API_KEY is missing", async () => {
    delete process.env.PERPLEXITY_API_KEY;
    await expect(perplexitySearch("q")).rejects.toThrow(/PERPLEXITY_API_KEY/);
  });

  it("surfaces Retry-After header in 429 error message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    ) as unknown as typeof fetch;

    await expect(perplexitySearch("q")).rejects.toThrow(/retry-after=30/);
  });

  it("throws descriptive error when 200 body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>cloudflare error</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(perplexitySearch("q")).rejects.toThrow(/json parse failed/);
  });
});
