import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openaiSearch } from "./openai.js";

describe("openaiSearch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env.OPENAI_API_KEY = "sk-test-key"; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
    vi.restoreAllMocks();
  });

  it("extracts url_citation annotations and answer text from a Responses payload", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "For Austin plumbing, Acme Plumbing is a well-rated option.",
                  annotations: [
                    { type: "url_citation", url: "https://acmeplumbing.com/" },
                    { type: "url_citation", url: "https://yelp.com/biz/acme" },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const r = await openaiSearch("best plumber austin");
    expect(r.citations).toEqual(["https://acmeplumbing.com/", "https://yelp.com/biz/acme"]);
    expect(r.answerText).toContain("Acme Plumbing");
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("deduplicates url_citation entries across multiple output items", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "one", annotations: [
                  { type: "url_citation", url: "https://a.com" },
                  { type: "url_citation", url: "https://b.com" },
                ] },
              ],
            },
            {
              type: "message",
              content: [
                { type: "output_text", text: "two", annotations: [
                  { type: "url_citation", url: "https://a.com" },  // dup
                  { type: "url_citation", url: "https://c.com" },
                ] },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const r = await openaiSearch("q");
    expect(r.citations).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(r.answerText).toBe("one\ntwo");
  });

  it("falls back to output_text when output[] is missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ output_text: "bare answer" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const r = await openaiSearch("q");
    expect(r.citations).toEqual([]);
    expect(r.answerText).toBe("bare answer");
  });

  it("returns empty citations when no url_citation annotations are present", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "no cites", annotations: [] }] }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const r = await openaiSearch("q");
    expect(r.citations).toEqual([]);
    expect(r.answerText).toBe("no cites");
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("server error", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(openaiSearch("q")).rejects.toThrow(/500/);
  });

  it("throws if OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(openaiSearch("q")).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("surfaces Retry-After header in 429 error message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Retry-After": "60" },
      }),
    ) as unknown as typeof fetch;

    await expect(openaiSearch("q")).rejects.toThrow(/retry-after=60/);
  });

  it("throws descriptive error when 200 body is not JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("<html>edge error</html>", { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(openaiSearch("q")).rejects.toThrow(/json parse failed/);
  });
});
