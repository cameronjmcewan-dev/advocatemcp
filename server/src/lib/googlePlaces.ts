/* Google Places API (New) integration for verifiable ratings.
 *
 * Tenant flow on the Verified Ratings card:
 *   1. Paste Google Maps URL ("Share → Copy link" → either long form or
 *      maps.app.goo.gl short).
 *   2. Click "Verify with Google" → server hits Places API and returns
 *      { rating, count, reviews[] } populated from the *real* listing.
 *   3. We persist into ratings_json.google.{value,count,url,verified_at}
 *      and customer_quotes_json so the per-bot HTML renderer can cite
 *      both the aggregate rating *and* representative quotes verbatim.
 *
 * Why "(New)" not classic Places: classic deprecates Mar 1 2025 for new
 * customers; New is the supported surface and has a per-field cost model
 * we can keep tight (~$0.005/call for the fields we ask for).
 *
 * Cost guard rails (defense in depth):
 *   - Per-slug rate limit (1 fetch / hour) → middleware in agent.ts
 *   - Daily budget kill switch reserve($0.05) → agent.ts wraps the call
 *   - Graceful fallback: if GOOGLE_PLACES_API_KEY isn't set or the call
 *     fails, the endpoint returns 503 with a clear message — the tenant
 *     can still self-report manually (existing path).
 *
 * No PII leaves Railway. Reviewer display names + review text come back
 * already-public (Google shows them on the public listing). We do NOT
 * pass the user's IP, browser, or any identifiers to Google. */

const PLACES_API_BASE = "https://places.googleapis.com/v1/places";
const FIELD_MASK = [
  "rating",
  "userRatingCount",
  "reviews.text.text",
  "reviews.rating",
  "reviews.authorAttribution.displayName",
  "reviews.publishTime",
  "reviews.relativePublishTimeDescription",
  "googleMapsUri",
  "displayName",
  "formattedAddress",
].join(",");

export interface PlaceDetails {
  rating: number | null;
  userRatingCount: number | null;
  googleMapsUri: string | null;
  displayName: string | null;
  formattedAddress: string | null;
  reviews: Array<{
    rating: number;
    text: string;
    author: string;
    publishTime: string;
    relativeTime: string | null;
  }>;
}

export interface PlaceFetchResult {
  ok: true;
  placeId: string;
  details: PlaceDetails;
}

export interface PlaceFetchError {
  ok: false;
  reason:
    | "no_api_key"
    | "invalid_url"
    | "place_not_found"
    | "places_api_error"
    | "redirect_failed";
  message: string;
  status?: number;
}

/* Extract a Place ID from a pasted Google Maps URL or from a raw
 * Place ID string (ChIJ..., 0x...:0x...). Returns null if neither
 * pattern matches.
 *
 * Long-form Maps URLs embed the place ID as `!1s<id>` inside the
 * `data=` parameter, e.g.:
 *   .../data=!3m1!4b1!4m6!3m5!1s0x89c25...:0xabc...!8m2!3d40...!4d-74...
 *
 * We do NOT handle short links (maps.app.goo.gl/...) here — those
 * require an HTTP redirect to resolve, see resolveShortMapsUrl(). */
export function extractPlaceIdFromInput(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Raw Place ID (newer ChIJ format, ~27 chars, base64-url-ish)
  if (/^ChIJ[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;

  // Raw legacy hex format (0x...:0x...)
  const legacyMatch = trimmed.match(/^(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)$/);
  if (legacyMatch) return legacyMatch[1];

  // Long-form Maps URL — pull from !1s<id>
  const dataMatch = trimmed.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+|ChIJ[A-Za-z0-9_-]+)/);
  if (dataMatch) return dataMatch[1];

  // ?ftid=0x... (older share format, sometimes from cid lookup)
  const ftidMatch = trimmed.match(/[?&]ftid=(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
  if (ftidMatch) return ftidMatch[1];

  return null;
}

/* Follow a maps.app.goo.gl or goo.gl/maps redirect and return the
 * resolved long-form URL. We use a manual fetch with redirect:'manual'
 * so we can read the Location header, since followed redirects from
 * Google's short link service occasionally chain through several hops
 * before settling on the real URL.
 *
 * This is the only place this module hits the open internet. We cap
 * the attempts (3 hops) so a malicious or broken short link can't
 * spin us forever. */
export async function resolveShortMapsUrl(url: string, maxHops = 3): Promise<string | null> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    try {
      const resp = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "AdvocateMCP/1.0 (+https://advocatemcp.com)" },
      });
      if (resp.status >= 300 && resp.status < 400) {
        const next = resp.headers.get("location");
        if (!next) return null;
        // Absolute or relative — handle both
        current = next.startsWith("http") ? next : new URL(next, current).toString();
        // If the redirect lands on a long-form maps URL we can stop early
        if (/google\.[a-z.]+\/maps\//.test(current)) return current;
      } else if (resp.status === 200) {
        // Some short links resolve via 200 + redirect chain in JS — give up
        return current;
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  return current;
}

/* True for Google Maps short-link domains. Keep this conservative —
 * we only follow redirects for hosts we recognize. */
export function isShortMapsUrl(input: string): boolean {
  if (!input) return false;
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\b/.test(input.trim());
}

/* Hit the Places API (New) for a known Place ID and shape the
 * response into our internal PlaceDetails type.
 *
 * We deliberately ask for a small field mask — billing scales with
 * SKU tier, and the fields we need (rating, count, ≤5 reviews) are
 * all in the cheaper Pro/Atomic tiers. */
export async function fetchPlaceDetails(
  placeId: string,
  apiKey: string,
): Promise<PlaceFetchResult | PlaceFetchError> {
  if (!apiKey) {
    return { ok: false, reason: "no_api_key", message: "GOOGLE_PLACES_API_KEY env var not configured." };
  }
  const url = `${PLACES_API_BASE}/${encodeURIComponent(placeId)}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
        "Accept": "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      reason: "places_api_error",
      message: `Network error contacting Places API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (resp.status === 404) {
    return { ok: false, reason: "place_not_found", status: 404, message: "Google does not recognize that Place ID." };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return {
      ok: false,
      reason: "places_api_error",
      status: resp.status,
      message: `Places API ${resp.status}: ${body.slice(0, 200)}`,
    };
  }

  const raw = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  const reviewsRaw = Array.isArray(raw.reviews) ? (raw.reviews as Array<Record<string, unknown>>) : [];
  const reviews = reviewsRaw.map((r) => {
    const text = (r.text as { text?: string } | undefined)?.text ?? "";
    const author = (r.authorAttribution as { displayName?: string } | undefined)?.displayName ?? "";
    return {
      rating: typeof r.rating === "number" ? r.rating : 0,
      text: typeof text === "string" ? text : "",
      author: typeof author === "string" ? author : "",
      publishTime: typeof r.publishTime === "string" ? r.publishTime : "",
      relativeTime: typeof r.relativePublishTimeDescription === "string" ? r.relativePublishTimeDescription : null,
    };
  });

  const displayName =
    (raw.displayName as { text?: string } | undefined)?.text ??
    (typeof raw.displayName === "string" ? raw.displayName : null);

  return {
    ok: true,
    placeId,
    details: {
      rating: typeof raw.rating === "number" ? raw.rating : null,
      userRatingCount: typeof raw.userRatingCount === "number" ? raw.userRatingCount : null,
      googleMapsUri: typeof raw.googleMapsUri === "string" ? raw.googleMapsUri : null,
      displayName,
      formattedAddress: typeof raw.formattedAddress === "string" ? raw.formattedAddress : null,
      reviews,
    },
  };
}

/* Single-call helper that takes whatever the user pasted and does the
 * full resolve→extract→fetch dance. Returns PlaceFetchResult or
 * PlaceFetchError. Used by the Express route. */
export async function verifyGoogleRating(
  pastedUrl: string,
  apiKey: string,
): Promise<PlaceFetchResult | PlaceFetchError> {
  let inputForExtract = pastedUrl;
  if (isShortMapsUrl(pastedUrl)) {
    const resolved = await resolveShortMapsUrl(pastedUrl);
    if (!resolved) {
      return {
        ok: false,
        reason: "redirect_failed",
        message: "Could not follow the Google Maps short link. Try the full URL from Maps' address bar instead.",
      };
    }
    inputForExtract = resolved;
  }

  const placeId = extractPlaceIdFromInput(inputForExtract);
  if (!placeId) {
    return {
      ok: false,
      reason: "invalid_url",
      message:
        "Couldn't find a Place ID in that URL. Make sure it's the long-form Google Maps link (it should contain '/place/' or '!1s').",
    };
  }
  return fetchPlaceDetails(placeId, apiKey);
}
