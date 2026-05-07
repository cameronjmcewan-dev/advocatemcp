/**
 * Tests for worker/src/lib/ga4.ts
 *
 * Runs in Node via vitest. All HTTP is mocked via globalThis.fetch so no
 * network calls are made. Each test group exercises one exported function.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshAccessToken, listProperties, fetchDailyTraffic } from "./ga4.js";

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

// ── refreshAccessToken ────────────────────────────────────────────────────────

describe("refreshAccessToken", () => {
  it("1. POSTs to the correct token endpoint", async () => {
    mockFetch({ access_token: "ya29.new", expires_in: 3600 });
    await refreshAccessToken("rt_abc", "cid_123", "csec_xyz");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("2. sends form-encoded body with all required fields", async () => {
    mockFetch({ access_token: "ya29.new", expires_in: 3600 });
    await refreshAccessToken("my-refresh-token", "my-client-id", "my-client-secret");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = init.body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=my-refresh-token");
    expect(body).toContain("client_id=my-client-id");
    expect(body).toContain("client_secret=my-client-secret");
  });

  it("3. returns parsed accessToken and expiresIn on 200", async () => {
    mockFetch({ access_token: "ya29.test-token", expires_in: 7200 });
    const result = await refreshAccessToken("rt", "cid", "csec");
    expect(result).toEqual({ accessToken: "ya29.test-token", expiresIn: 7200 });
  });

  it("4. throws ga4-prefixed error on non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("invalid_grant", { status: 400 }),
    );
    await expect(refreshAccessToken("bad-token", "cid", "csec")).rejects.toThrow(
      /ga4: refresh failed: 400/,
    );
  });

  it("5. error message includes first 200 chars of body snippet", async () => {
    const errorBody = "invalid_client: The OAuth client was not found.";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(errorBody, { status: 401 }),
    );
    await expect(refreshAccessToken("rt", "bad-cid", "csec")).rejects.toThrow(
      /invalid_client/,
    );
  });
});

// ── listProperties ────────────────────────────────────────────────────────────

describe("listProperties", () => {
  const accountSummariesResponse = {
    accountSummaries: [
      {
        account: "accounts/111",
        displayName: "Acme Inc",
        propertySummaries: [
          { property: "properties/123", displayName: "Acme Website" },
          { property: "properties/456", displayName: "Acme Blog" },
        ],
      },
      {
        account: "accounts/222",
        displayName: "Beta Corp",
        propertySummaries: [
          { property: "properties/789", displayName: "Beta App" },
        ],
      },
    ],
  };

  it("6. GETs the accountSummaries endpoint with Bearer token", async () => {
    mockFetch(accountSummariesResponse);
    await listProperties("ya29.access-token");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://analyticsadmin.googleapis.com/v1beta/accountSummaries",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ya29.access-token",
        }),
      }),
    );
  });

  it("7. flattens nested propertySummaries into a single array", async () => {
    mockFetch(accountSummariesResponse);
    const props = await listProperties("ya29.tok");
    expect(props).toHaveLength(3);
    expect(props[0]).toEqual({ propertyId: "properties/123", displayName: "Acme Website" });
    expect(props[1]).toEqual({ propertyId: "properties/456", displayName: "Acme Blog" });
    expect(props[2]).toEqual({ propertyId: "properties/789", displayName: "Beta App" });
  });

  it("8. throws ga4-prefixed error with body snippet on non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Quota exhausted: tokens=10000/10000", { status: 403 }),
    );
    await expect(listProperties("ya29.expired")).rejects.toThrow(
      /ga4: listProperties failed: 403 .*Quota exhausted/,
    );
  });

  it("9. returns empty array when accountSummaries is absent", async () => {
    mockFetch({});
    const props = await listProperties("ya29.tok");
    expect(props).toEqual([]);
  });
});

// ── fetchDailyTraffic ─────────────────────────────────────────────────────────

describe("fetchDailyTraffic", () => {
  const gaResponse = {
    rows: [
      {
        dimensionValues: [
          { value: "20260506" },
          { value: "perplexity.ai" },
          { value: "referral" },
        ],
        metricValues: [
          { value: "42" },   // sessions
          { value: "35" },   // engagedSessions
          { value: "90.5" }, // averageSessionDuration
          { value: "0.19" }, // bounceRate
          { value: "30" },   // newUsers
          { value: "42" },   // totalUsers
        ],
      },
      {
        dimensionValues: [
          { value: "20260505" },
          { value: "google" },
          { value: "organic" },
        ],
        metricValues: [
          { value: "108" },  // sessions
          { value: "80" },   // engagedSessions
          { value: "120.0" },// averageSessionDuration
          { value: "0.26" }, // bounceRate
          { value: "55" },   // newUsers
          { value: "108" },  // totalUsers
        ],
      },
    ],
  };

  const opts = {
    propertyId: "properties/123456789",
    startDate: "2024-11-06",
    endDate: "2026-05-05",
    accessToken: "ya29.sync-token",
  };

  it("10. POSTs to the correct runReport endpoint", async () => {
    mockFetch(gaResponse);
    await fetchDailyTraffic(opts);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("11. sends correct JSON body with dateRanges, dimensions, all six metrics", async () => {
    mockFetch(gaResponse);
    await fetchDailyTraffic(opts);
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string);
    expect(body.dateRanges).toEqual([{ startDate: "2024-11-06", endDate: "2026-05-05" }]);
    expect(body.dimensions).toEqual([
      { name: "date" },
      { name: "sessionSource" },
      { name: "sessionMedium" },
    ]);
    expect(body.metrics).toEqual([
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "averageSessionDuration" },
      { name: "bounceRate" },
      { name: "newUsers" },
      { name: "totalUsers" },
    ]);
    expect(body.limit).toBe(100000);
  });

  it("12. converts YYYYMMDD dates to YYYY-MM-DD in returned rows", async () => {
    mockFetch(gaResponse);
    const rows = await fetchDailyTraffic(opts);
    expect(rows[0].date).toBe("2026-05-06");
    expect(rows[1].date).toBe("2026-05-05");
  });

  it("13. parses source, medium, sessions and all new metric fields correctly", async () => {
    mockFetch(gaResponse);
    const rows = await fetchDailyTraffic(opts);
    expect(rows[0]).toEqual({
      date: "2026-05-06",
      source: "perplexity.ai",
      medium: "referral",
      sessions: 42,
      engagedSessions: 35,
      averageSessionDuration: 90.5,
      bounceRate: 0.19,
      newUsers: 30,
      totalUsers: 42,
    });
    expect(rows[1]).toEqual({
      date: "2026-05-05",
      source: "google",
      medium: "organic",
      sessions: 108,
      engagedSessions: 80,
      averageSessionDuration: 120.0,
      bounceRate: 0.26,
      newUsers: 55,
      totalUsers: 108,
    });
  });

  it("14. returns empty array when rows is absent or empty", async () => {
    mockFetch({ rows: [] });
    const rows = await fetchDailyTraffic(opts);
    expect(rows).toEqual([]);

    mockFetch({});
    const rows2 = await fetchDailyTraffic(opts);
    expect(rows2).toEqual([]);
  });

  it("15. throws ga4-prefixed error with body snippet on non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":{"code":429,"message":"Quota exceeded"}}', { status: 429 }),
    );
    await expect(fetchDailyTraffic(opts)).rejects.toThrow(
      /ga4: runReport failed: 429 .*Quota exceeded/,
    );
  });

  it("16. parses bounceRate correctly when GA4 returns '0.42'", async () => {
    mockFetch({
      rows: [{
        dimensionValues: [{ value: "20260506" }, { value: "google" }, { value: "organic" }],
        metricValues: [
          { value: "100" }, // sessions
          { value: "58" },  // engagedSessions
          { value: "75.0" },// averageSessionDuration
          { value: "0.42" },// bounceRate
          { value: "40" },  // newUsers
          { value: "100" }, // totalUsers
        ],
      }],
    });
    const rows = await fetchDailyTraffic(opts);
    expect(rows[0].bounceRate).toBe(0.42);
  });

  it("17. parses averageSessionDuration as float when GA4 returns '67.8'", async () => {
    mockFetch({
      rows: [{
        dimensionValues: [{ value: "20260506" }, { value: "google" }, { value: "organic" }],
        metricValues: [
          { value: "50" },  // sessions
          { value: "30" },  // engagedSessions
          { value: "67.8" },// averageSessionDuration
          { value: "0.30" },// bounceRate
          { value: "20" },  // newUsers
          { value: "50" },  // totalUsers
        ],
      }],
    });
    const rows = await fetchDailyTraffic(opts);
    expect(rows[0].averageSessionDuration).toBe(67.8);
  });

  it("18. handles missing optional metric values gracefully (default to 0)", async () => {
    mockFetch({
      rows: [{
        dimensionValues: [{ value: "20260506" }, { value: "google" }, { value: "organic" }],
        // Only sessions metric value present — others absent
        metricValues: [{ value: "50" }],
      }],
    });
    const rows = await fetchDailyTraffic(opts);
    expect(rows[0].sessions).toBe(50);
    expect(rows[0].engagedSessions).toBe(0);
    expect(rows[0].averageSessionDuration).toBe(0);
    expect(rows[0].bounceRate).toBe(0);
    expect(rows[0].newUsers).toBe(0);
    expect(rows[0].totalUsers).toBe(0);
  });
});
