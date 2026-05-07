/**
 * Tests for worker/src/lib/googlePlaces.ts
 *
 * All tests mock globalThis.fetch — no real network calls.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchPlaceDetails, googleRatingToSentiment } from "./googlePlaces.js";

// ── fetch mock helpers ────────────────────────────────────────────────────────

function mockFetch(response: { ok: boolean; status: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  const fn = vi.fn().mockResolvedValue({
    ok:   response.ok,
    status: response.status,
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve("")),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── fetchPlaceDetails ─────────────────────────────────────────────────────────

describe("fetchPlaceDetails", () => {
  it("1. builds correct request URL with place_id, fields, and key", async () => {
    const fetchMock = mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({
        status: "OK",
        result: { name: "Acme Co", rating: 4.5, user_ratings_total: 100, reviews: [] },
      }),
    });

    await fetchPlaceDetails({ placeId: "ChIJtest123", apiKey: "ak_test" });

    const calledUrl = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toContain("place_id=ChIJtest123");
    // fields is sent as a comma-separated string (not percent-encoded) — Google accepts both forms.
    expect(calledUrl).toContain("fields=name,rating,user_ratings_total,reviews");
    expect(calledUrl).toContain("key=ak_test");
    expect(calledUrl).toContain("maps.googleapis.com/maps/api/place/details/json");
  });

  it("2. parses happy-path response with reviews and overall rating", async () => {
    mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({
        status: "OK",
        result: {
          name:               "Bamboo Brace",
          rating:             4.8,
          user_ratings_total: 320,
          reviews: [
            {
              author_name:               "Alice",
              rating:                    5,
              text:                      "Great service!",
              time:                      1746489600,
              relative_time_description: "2 weeks ago",
            },
            {
              author_name: "Bob",
              rating:      3,
              text:        "Average.",
              time:        1745884800,
            },
          ],
        },
      }),
    });

    const details = await fetchPlaceDetails({ placeId: "ChIJbamboo", apiKey: "ak_test" });

    expect(details.name).toBe("Bamboo Brace");
    expect(details.rating).toBe(4.8);
    expect(details.user_ratings_total).toBe(320);
    expect(details.reviews).toHaveLength(2);
    expect(details.reviews[0]!.author_name).toBe("Alice");
    expect(details.reviews[0]!.rating).toBe(5);
    expect(details.reviews[0]!.relative_time_description).toBe("2 weeks ago");
    expect(details.reviews[1]!.relative_time_description).toBeUndefined();
  });

  it("3. empty reviews array returns reviews=[]", async () => {
    mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({
        status: "OK",
        result: { name: "No Reviews Place", rating: 0, user_ratings_total: 0 },
        // reviews field is absent — simulates a new Place with no reviews
      }),
    });

    const details = await fetchPlaceDetails({ placeId: "ChIJempty", apiKey: "ak_test" });

    expect(details.reviews).toEqual([]);
    expect(details.name).toBe("No Reviews Place");
  });

  it("4. status=ZERO_RESULTS throws with the specific status string", async () => {
    mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({ status: "ZERO_RESULTS" }),
    });

    await expect(
      fetchPlaceDetails({ placeId: "ChIJnotfound", apiKey: "ak_test" }),
    ).rejects.toThrow("googlePlaces: fetch failed: ZERO_RESULTS");
  });

  it("4b. status=NOT_FOUND throws with the specific status string", async () => {
    mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({ status: "NOT_FOUND" }),
    });

    await expect(
      fetchPlaceDetails({ placeId: "ChIJbad", apiKey: "ak_test" }),
    ).rejects.toThrow("googlePlaces: fetch failed: NOT_FOUND");
  });

  it("5. HTTP 403 throws with googlePlaces: fetch failed: 403", async () => {
    mockFetch({
      ok:     false,
      status: 403,
      text:   () => Promise.resolve("REQUEST_DENIED"),
    });

    await expect(
      fetchPlaceDetails({ placeId: "ChIJtest", apiKey: "bad_key" }),
    ).rejects.toThrow("googlePlaces: fetch failed: 403");
  });

  it("6. missing result field throws an error", async () => {
    mockFetch({
      ok:     true,
      status: 200,
      json:   () => Promise.resolve({ status: "OK" }),
      // result field intentionally absent
    });

    await expect(
      fetchPlaceDetails({ placeId: "ChIJtest", apiKey: "ak_test" }),
    ).rejects.toThrow("googlePlaces: fetch failed: missing result in response");
  });
});

// ── googleRatingToSentiment ───────────────────────────────────────────────────

describe("googleRatingToSentiment", () => {
  it("5 stars → positive, score=1.0", () => {
    expect(googleRatingToSentiment(5)).toEqual({ label: "positive", score: 1.0 });
  });

  it("4 stars → positive, score=0.5", () => {
    expect(googleRatingToSentiment(4)).toEqual({ label: "positive", score: 0.5 });
  });

  it("3 stars → neutral, score=0", () => {
    expect(googleRatingToSentiment(3)).toEqual({ label: "neutral", score: 0.0 });
  });

  it("2 stars → negative, score=-0.5", () => {
    expect(googleRatingToSentiment(2)).toEqual({ label: "negative", score: -0.5 });
  });

  it("1 star → negative, score=-1.0", () => {
    expect(googleRatingToSentiment(1)).toEqual({ label: "negative", score: -1.0 });
  });

  it("boundary: 4.5 → positive, score=1.0", () => {
    expect(googleRatingToSentiment(4.5)).toEqual({ label: "positive", score: 1.0 });
  });

  it("boundary: 3.5 → positive, score=0.5", () => {
    expect(googleRatingToSentiment(3.5)).toEqual({ label: "positive", score: 0.5 });
  });
});
