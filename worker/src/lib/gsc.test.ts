/**
 * Tests for worker/src/lib/gsc.ts
 *
 * Runs in Node via vitest. All HTTP is mocked via globalThis.fetch so no
 * network calls are made. Each test group exercises one exported function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { listSites, fetchSearchAnalytics } from "./gsc.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── listSites ─────────────────────────────────────────────────────────────────

describe("listSites", () => {
  const sitesResponse = {
    siteEntry: [
      { siteUrl: "https://example.com/",   permissionLevel: "siteOwner" },
      { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://unverified.com/",  permissionLevel: "siteUnverifiedUser" },
    ],
  };

  it("1. GETs the correct endpoint with Bearer auth, parses siteEntry[], filters non-owner permissions", async () => {
    mockFetch(sitesResponse);
    const sites = await listSites("ya29.access-token");

    // Correct endpoint + auth header
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://searchconsole.googleapis.com/webmasters/v3/sites",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.access-token",
        }),
      }),
    );

    // Returns only siteOwner + siteFullUser (not siteUnverifiedUser)
    expect(sites).toHaveLength(2);
    expect(sites[0]).toEqual({ siteUrl: "https://example.com/",      permissionLevel: "siteOwner" });
    expect(sites[1]).toEqual({ siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" });
  });

  it("2. returns empty array when siteEntry is absent", async () => {
    mockFetch({});
    const sites = await listSites("ya29.tok");
    expect(sites).toEqual([]);
  });

  it("3. returns empty array when all entries have non-owner permissions", async () => {
    mockFetch({
      siteEntry: [
        { siteUrl: "https://unverified.com/", permissionLevel: "siteUnverifiedUser" },
        { siteUrl: "https://restricted.com/", permissionLevel: "siteRestrictedUser" },
      ],
    });
    const sites = await listSites("ya29.tok");
    expect(sites).toEqual([]);
  });

  it("4. throws gsc-prefixed error with status + body snippet on 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":403,"message":"Request had insufficient authentication scopes"}}', { status: 403 }),
    );
    await expect(listSites("ya29.expired")).rejects.toThrow(
      /gsc: listSites failed: 403 .*insufficient authentication/,
    );
  });
});

// ── fetchSearchAnalytics ──────────────────────────────────────────────────────

describe("fetchSearchAnalytics", () => {
  const happyRows = {
    rows: [
      {
        keys:        ["2026-05-06", "best plumber austin"],
        clicks:      12,
        impressions: 340,
        ctr:         0.035,
        position:    4.2,
      },
      {
        keys:        ["2026-05-06", "emergency plumber near me"],
        clicks:      5,
        impressions: 120,
        ctr:         0.042,
        position:    2.8,
      },
    ],
  };

  const opts = {
    siteUrl:     "https://example.com/",
    startDate:   "2026-05-01",
    endDate:     "2026-05-06",
    accessToken: "ya29.search-token",
  };

  it("5. sends correct POST with URL-encoded siteUrl, dimensions, dateRanges, rowLimit", async () => {
    mockFetch(happyRows);
    await fetchSearchAnalytics(opts);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    // URL-encoded siteUrl in path
    expect(url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query",
    );
    // POST method
    expect(init.method).toBe("POST");
    // Bearer auth header
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer ya29.search-token");

    // Correct request body
    const body = JSON.parse(init.body as string);
    expect(body.startDate).toBe("2026-05-01");
    expect(body.endDate).toBe("2026-05-06");
    expect(body.dimensions).toEqual(["date", "query"]);
    expect(body.rowLimit).toBe(25000);
  });

  it("6. parses happy-path rows correctly (date stays YYYY-MM-DD, numerics parsed)", async () => {
    mockFetch(happyRows);
    const rows = await fetchSearchAnalytics(opts);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date:        "2026-05-06",
      query:       "best plumber austin",
      clicks:      12,
      impressions: 340,
      ctr:         0.035,
      position:    4.2,
    });
    expect(rows[1]).toEqual({
      date:        "2026-05-06",
      query:       "emergency plumber near me",
      clicks:      5,
      impressions: 120,
      ctr:         0.042,
      position:    2.8,
    });
  });

  it("7. returns empty array when rows is absent or empty", async () => {
    mockFetch({ rows: [] });
    const rows1 = await fetchSearchAnalytics(opts);
    expect(rows1).toEqual([]);

    mockFetch({});
    const rows2 = await fetchSearchAnalytics(opts);
    expect(rows2).toEqual([]);
  });

  it("8. throws gsc-prefixed error with status + body snippet on 403", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":403,"message":"User does not have sufficient permissions"}}', { status: 403 }),
    );
    await expect(fetchSearchAnalytics(opts)).rejects.toThrow(
      /gsc: searchAnalytics failed: 403 .*sufficient permissions/,
    );
  });

  it("9. uses custom rowLimit when provided instead of default 25000", async () => {
    mockFetch(happyRows);
    await fetchSearchAnalytics({ ...opts, rowLimit: 1000 });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.rowLimit).toBe(1000);
  });

  it("10. URL-encodes siteUrl with trailing slash correctly in path", async () => {
    mockFetch({ rows: [] });
    await fetchSearchAnalytics({ ...opts, siteUrl: "https://my-site.example.co.uk/" });

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("https%3A%2F%2Fmy-site.example.co.uk%2F");
  });
});
