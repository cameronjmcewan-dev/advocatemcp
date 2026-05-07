/**
 * Google Places API client. Pulls a single Place's reviews + rating
 * + total rating count for the customer's specified Place ID.
 *
 * Server-side API key model: the customer doesn't OAuth — they paste
 * their public Place ID (e.g. "ChIJN1t_tDeuEmsRUsoyG83frY4") and we
 * use Advocate's own GOOGLE_PLACES_API_KEY to fetch their reviews.
 *
 * Errors prefixed `googlePlaces:`.
 */

const PLACES_BASE = "https://maps.googleapis.com/maps/api/place/details/json";
const PLACES_FIELDS = "name,rating,user_ratings_total,reviews";

export interface GoogleReview {
  author_name:               string;
  rating:                    number;        // 1..5 (Google's scale)
  text:                      string;
  time:                      number;        // unix seconds
  relative_time_description?: string;
}

export interface GooglePlaceDetails {
  name:                string;
  rating:              number;        // overall Google rating 1..5 (decimal)
  user_ratings_total:  number;
  reviews:             GoogleReview[];
}

export async function fetchPlaceDetails(opts: {
  placeId: string;
  apiKey:  string;
}): Promise<GooglePlaceDetails> {
  const url = `${PLACES_BASE}?place_id=${encodeURIComponent(opts.placeId)}&fields=${PLACES_FIELDS}&key=${encodeURIComponent(opts.apiKey)}`;

  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`googlePlaces: fetch failed: network error: ${String(err)}`);
  }

  if (!resp.ok) {
    const snippet = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`googlePlaces: fetch failed: ${resp.status} ${snippet}`);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new Error("googlePlaces: fetch failed: invalid JSON response");
  }

  const raw = body as Record<string, unknown>;
  const status = raw.status as string | undefined;
  if (status !== "OK") {
    throw new Error(`googlePlaces: fetch failed: ${status ?? "UNKNOWN_STATUS"}`);
  }

  const result = raw.result as Record<string, unknown> | undefined;
  if (!result) {
    throw new Error("googlePlaces: fetch failed: missing result in response");
  }

  const rawReviews = (result.reviews as unknown[] | undefined) ?? [];
  const reviews: GoogleReview[] = rawReviews.map((r) => {
    const rv = r as Record<string, unknown>;
    return {
      author_name:               String(rv.author_name ?? ""),
      rating:                    Number(rv.rating ?? 0),
      text:                      String(rv.text ?? ""),
      time:                      Number(rv.time ?? 0),
      relative_time_description: rv.relative_time_description !== undefined
        ? String(rv.relative_time_description)
        : undefined,
    };
  });

  return {
    name:               String(result.name ?? ""),
    rating:             Number(result.rating ?? 0),
    user_ratings_total: Number(result.user_ratings_total ?? 0),
    reviews,
  };
}

/**
 * Maps a Google review's integer star rating (1–5) to a sentiment label
 * + score. Uses half-integer boundaries so 4.5 maps to positive/1.0, etc.
 * No Claude call needed — the explicit star rating is more reliable and free.
 */
export function googleRatingToSentiment(rating: number): { label: "positive" | "neutral" | "negative"; score: number } {
  if (rating >= 4.5) return { label: "positive", score:  1.0 };
  if (rating >= 3.5) return { label: "positive", score:  0.5 };
  if (rating >= 2.5) return { label: "neutral",  score:  0.0 };
  if (rating >= 1.5) return { label: "negative", score: -0.5 };
  return                     { label: "negative", score: -1.0 };
}
