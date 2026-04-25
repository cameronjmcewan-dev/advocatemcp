/* Unit tests for Google Places integration.
 *
 * Network is mocked via vi.fn() globalThis.fetch — no real Places API
 * calls during tests. We assert:
 *   - URL parsing (long form, raw IDs, query-string ftid, garbage)
 *   - Short URL detection
 *   - PlaceDetails shape mapping
 *   - Error paths (no key, 404, 5xx, network failure)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractPlaceIdFromInput,
  fetchPlaceDetails,
  isShortMapsUrl,
  resolveShortMapsUrl,
  verifyGoogleRating,
} from "./googlePlaces.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("extractPlaceIdFromInput", () => {
  it("returns null on empty / whitespace input", () => {
    expect(extractPlaceIdFromInput("")).toBeNull();
    expect(extractPlaceIdFromInput("   ")).toBeNull();
  });

  it("extracts raw ChIJ Place IDs", () => {
    expect(extractPlaceIdFromInput("ChIJN1t_tDeuEmsRUsoyG83frY4")).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  });

  it("extracts raw legacy hex Place IDs", () => {
    expect(extractPlaceIdFromInput("0x89c259a9b71ed63d:0xabc123def456")).toBe("0x89c259a9b71ed63d:0xabc123def456");
  });

  it("extracts Place ID from long-form Maps URL via !1s", () => {
    const url =
      "https://www.google.com/maps/place/Workman+Copy+Co/@40.7,-74,17z/data=!3m1!4b1!4m6!3m5!1s0x89c259a9b71ed63d:0xabc123def456!8m2!3d40.7!4d-74!16s%2Fg%2F11abcd1234?entry=ttu";
    expect(extractPlaceIdFromInput(url)).toBe("0x89c259a9b71ed63d:0xabc123def456");
  });

  it("extracts ChIJ from a long-form URL", () => {
    const url =
      "https://www.google.com/maps/place/Cafe/@40,-74,17z/data=!4m6!3m5!1sChIJN1t_tDeuEmsRUsoyG83frY4!8m2!3d40!4d-74";
    expect(extractPlaceIdFromInput(url)).toBe("ChIJN1t_tDeuEmsRUsoyG83frY4");
  });

  it("extracts ftid query parameter", () => {
    const url = "https://www.google.com/maps?ftid=0x89c259a9b71ed63d:0xabc123def456";
    expect(extractPlaceIdFromInput(url)).toBe("0x89c259a9b71ed63d:0xabc123def456");
  });

  it("returns null on URLs without a Place ID", () => {
    expect(extractPlaceIdFromInput("https://www.google.com/maps")).toBeNull();
    expect(extractPlaceIdFromInput("not a url at all")).toBeNull();
  });
});

describe("isShortMapsUrl", () => {
  it("recognizes maps.app.goo.gl", () => {
    expect(isShortMapsUrl("https://maps.app.goo.gl/abcXYZ")).toBe(true);
  });
  it("recognizes goo.gl/maps", () => {
    expect(isShortMapsUrl("https://goo.gl/maps/abc")).toBe(true);
  });
  it("rejects long-form URLs", () => {
    expect(isShortMapsUrl("https://www.google.com/maps/place/X")).toBe(false);
  });
  it("rejects empty / unrelated input", () => {
    expect(isShortMapsUrl("")).toBe(false);
    expect(isShortMapsUrl("ChIJ123")).toBe(false);
  });
});

describe("resolveShortMapsUrl", () => {
  it("follows a single 302 to a long-form Maps URL", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://www.google.com/maps/place/X/data=!1sChIJN1t_tDeuEmsRUsoyG83frY4" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await resolveShortMapsUrl("https://maps.app.goo.gl/xyz");
    expect(out).toContain("/maps/place/");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns null when the redirect chain has no Location header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers(), // no location
    }) as unknown as typeof fetch;
    expect(await resolveShortMapsUrl("https://maps.app.goo.gl/x")).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net down")) as unknown as typeof fetch;
    expect(await resolveShortMapsUrl("https://maps.app.goo.gl/x")).toBeNull();
  });

  it("respects maxHops cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: "https://example.com/loop" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await resolveShortMapsUrl("https://maps.app.goo.gl/x", 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchPlaceDetails", () => {
  it("returns no_api_key when apiKey is empty", async () => {
    const out = await fetchPlaceDetails("ChIJ123", "");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("no_api_key");
  });

  it("maps a successful Places API response into PlaceDetails", async () => {
    const responsePayload = {
      rating: 4.8,
      userRatingCount: 42,
      googleMapsUri: "https://maps.google.com/?cid=12345",
      displayName: { text: "Workman Copy Co" },
      formattedAddress: "123 Main St",
      reviews: [
        {
          rating: 5,
          text: { text: "Best service in town." },
          authorAttribution: { displayName: "Jane D" },
          publishTime: "2024-05-15T10:00:00Z",
          relativePublishTimeDescription: "11 months ago",
        },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => responsePayload,
    }) as unknown as typeof fetch;

    const out = await fetchPlaceDetails("ChIJabc", "fake-key");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.placeId).toBe("ChIJabc");
      expect(out.details.rating).toBe(4.8);
      expect(out.details.userRatingCount).toBe(42);
      expect(out.details.displayName).toBe("Workman Copy Co");
      expect(out.details.reviews).toHaveLength(1);
      expect(out.details.reviews[0].text).toBe("Best service in town.");
      expect(out.details.reviews[0].author).toBe("Jane D");
      expect(out.details.reviews[0].relativeTime).toBe("11 months ago");
    }
  });

  it("returns place_not_found on 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "not found",
    }) as unknown as typeof fetch;
    const out = await fetchPlaceDetails("ChIJzzz", "fake-key");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("place_not_found");
  });

  it("returns places_api_error on 5xx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }) as unknown as typeof fetch;
    const out = await fetchPlaceDetails("ChIJ", "fake-key");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("places_api_error");
      expect(out.status).toBe(500);
    }
  });

  it("returns places_api_error on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const out = await fetchPlaceDetails("ChIJ", "fake-key");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("places_api_error");
  });
});

describe("verifyGoogleRating", () => {
  it("returns invalid_url for unparseable input", async () => {
    const out = await verifyGoogleRating("just some text", "fake-key");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("invalid_url");
  });

  it("flows long-URL → fetchPlaceDetails on happy path", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rating: 4.5, userRatingCount: 10 }),
    }) as unknown as typeof fetch;

    const url =
      "https://www.google.com/maps/place/X/@40,-74,17z/data=!1sChIJN1t_tDeuEmsRUsoyG83frY4!8m2!3d40!4d-74";
    const out = await verifyGoogleRating(url, "fake-key");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.details.rating).toBe(4.5);
  });

  it("returns redirect_failed when short URL doesn't resolve", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("net down")) as unknown as typeof fetch;
    const out = await verifyGoogleRating("https://maps.app.goo.gl/abc", "fake-key");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("redirect_failed");
  });
});
