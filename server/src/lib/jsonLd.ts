/**
 * Generate a schema.org LocalBusiness JSON-LD payload from a tenant's
 * BusinessRow. This is the structured-data format Google SGE, Bing Copilot,
 * and other search engines ingest to produce rich answers about a business.
 *
 * Why this lives in a dedicated lib rather than inline on a route:
 *   - Pure function (no I/O): easy to snapshot-test
 *   - Reused by two endpoints (the public JSON-LD fetch at
 *     /agents/:slug/json-ld.json and the dashboard "install snippet" card
 *     that wraps the same output in a <script type="application/ld+json">
 *     block)
 *   - Keeps the schema.org shape in one place so additions (sameAs links,
 *     openingHoursSpecification, etc.) don't have to be dual-maintained
 *
 * Strict scope for v1: emit only the fields that (a) the wizard actually
 * collects and (b) Google's LocalBusiness rich-result documentation flags
 * as relevant. Additions later — sameAs URLs once we capture them, hours
 * once the hours_json schema stabilizes enough to emit
 * openingHoursSpecification safely.
 */

import type { BusinessRow } from "../db.js";

type RatingSource = { rating: number; count: number };
type RatingsBlob = {
  google?: RatingSource; yelp?: RatingSource;
  facebook?: RatingSource; bbb?: RatingSource;
};

/**
 * Parse "Boise, ID" → { city: "Boise", state: "ID" }. Best-effort — if the
 * tenant entered a free-form string we can't split, we pass the whole thing
 * through as addressLocality. schema.org accepts that.
 */
function splitLocation(raw: string | null): { city: string; state?: string } {
  if (!raw) return { city: "" };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { city: parts[0]!, state: parts[1] };
  }
  return { city: parts[0] ?? raw };
}

/**
 * Map our internal pricing_tier to Google's priceRange convention ($, $$,
 * $$$, $$$$). "mid-range" is the modal answer for most SMBs so we default
 * there when the tenant didn't pick. Returns undefined if the tenant wants
 * to stay silent on pricing — we'd rather omit than misrepresent.
 */
function pricingTierToRange(tier: string | null): string | undefined {
  switch ((tier ?? "").toLowerCase()) {
    case "budget":    return "$";
    case "mid-range": return "$$";
    case "premium":   return "$$$";
    case "luxury":    return "$$$$";
    default:          return undefined;
  }
}

/**
 * Pick the most-reviews rating source across the platforms the wizard
 * tracks. Google → Yelp → Facebook → BBB order matches the first-populated
 * tie-break used elsewhere (see RATING_PLATFORMS in agent/builder.ts), so
 * the JSON-LD aggregateRating and the agent's spoken rating stay aligned.
 */
function bestAggregateRating(ratings: RatingsBlob | null, fallback: {
  value: number | null; count: number | null;
}): { value: number; count: number } | null {
  if (ratings) {
    for (const key of ["google", "yelp", "facebook", "bbb"] as const) {
      const r = ratings[key];
      if (r) return { value: r.rating, count: r.count };
    }
  }
  if (fallback.value != null && fallback.count != null) {
    return { value: fallback.value, count: fallback.count };
  }
  return null;
}

export interface BusinessJsonLd {
  "@context": "https://schema.org";
  "@type":    "LocalBusiness";
  name:        string;
  description: string;
  url?:        string;
  telephone?:  string;
  address?: {
    "@type":         "PostalAddress";
    addressLocality: string;
    addressRegion?:  string;
  };
  priceRange?: string;
  aggregateRating?: {
    "@type":       "AggregateRating";
    ratingValue:   number;
    reviewCount:   number;
    bestRating:    5;
    worstRating:   0;
  };
  // A unique identifier helps Google stitch the entity across its crawls.
  // We use our canonical API URL so the record is unambiguously ours.
  "@id"?: string;
}

export interface JsonLdOptions {
  /** Absolute URL for the @id field. Defaults to the tenant's website. */
  canonicalUrl?: string;
}

/**
 * Build the JSON-LD object from a BusinessRow. Null-safe: any field the
 * tenant hasn't filled is simply omitted from the output rather than
 * emitted as null — cleaner for crawlers and avoids polluting the rich
 * result with empty data.
 */
export function toLocalBusinessJsonLd(
  business: BusinessRow,
  opts: JsonLdOptions = {},
): BusinessJsonLd {
  const loc = splitLocation(business.location ?? null);

  let ratings: RatingsBlob | null = null;
  if (business.ratings_json) {
    try { ratings = JSON.parse(business.ratings_json) as RatingsBlob; }
    catch { ratings = null; }
  }
  const agg = bestAggregateRating(ratings, {
    value: business.star_rating ?? null,
    count: business.review_count ?? null,
  });

  const jsonLd: BusinessJsonLd = {
    "@context": "https://schema.org",
    "@type":    "LocalBusiness",
    name:        business.name,
    description: business.description,
  };

  const canonical = opts.canonicalUrl ?? business.website ?? undefined;
  if (canonical) jsonLd["@id"] = canonical;
  if (business.website) jsonLd.url = business.website;
  if (business.phone)   jsonLd.telephone = business.phone;

  if (loc.city) {
    jsonLd.address = {
      "@type":         "PostalAddress",
      addressLocality: loc.city,
      ...(loc.state ? { addressRegion: loc.state } : {}),
    };
  }

  const priceRange = pricingTierToRange(business.pricing_tier ?? null);
  if (priceRange) jsonLd.priceRange = priceRange;

  if (agg) {
    jsonLd.aggregateRating = {
      "@type":     "AggregateRating",
      ratingValue: agg.value,
      reviewCount: agg.count,
      bestRating:  5,
      worstRating: 0,
    };
  }

  return jsonLd;
}

/**
 * Wrap a JSON-LD object in the `<script type="application/ld+json">` block
 * Google / Bing expect in a page's `<head>`. Output is a single concatenated
 * string suitable for copy-paste installation; newlines inside the JSON are
 * preserved with two-space indent so the tenant sees something readable if
 * they view-source.
 */
export function wrapAsScriptTag(jsonLd: unknown): string {
  return [
    '<script type="application/ld+json">',
    JSON.stringify(jsonLd, null, 2),
    "</script>",
  ].join("\n");
}
