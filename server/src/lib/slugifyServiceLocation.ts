/**
 * Deterministic kebab-case slug helpers for synthetic-page URLs.
 *
 * URL stability is the contract: regenerating the same input must always
 * produce the same slug, and the slug must round-trip cleanly through URL
 * parsers + browsers. Used by:
 *   - server/src/jobs/syntheticPagesBuilder.ts — building the `path` field
 *     stored on `synthetic_pages.path`.
 *   - server/src/routes/syntheticPages.ts — parsing inbound paths to
 *     match against stored rows.
 *   - worker/src/index.ts — the `^/best-.+-(in|near)-.+/?$` matcher.
 *
 * Rules:
 *   - Lowercase ASCII alphanumeric + single hyphens between tokens
 *   - Diacritics stripped via NFKD normalization (so "café" → "cafe")
 *   - Non-alphanumerics collapsed to a single hyphen
 *   - Leading/trailing hyphens trimmed
 *   - Idempotent: slugify(slugify(x)) === slugify(x)
 *
 * Apr 28 2026 — Phase 3 grey-hat AI optimization layer.
 */

/** Slugify a service or location string into URL-safe kebab-case. */
export function slugifyOne(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")  // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the canonical synthetic-page path for a given intent + service +
 * location triple.
 *
 *   buildPath('best_top',  'emergency-plumbing', 'austin')
 *     → '/best-emergency-plumbing-in-austin'
 *   buildPath('affordable','solar-install',     'round-rock')
 *     → '/affordable-solar-install-in-round-rock'
 *   buildPath('emergency', 'water-heater',      'cedar-park')
 *     → '/emergency-water-heater-near-cedar-park'
 *   buildPath('specific_service', 'tankless-install', 'austin')
 *     → '/tankless-install-in-austin'
 *
 * Connector word (`in` vs `near`) varies by intent so the URL phrasing
 * matches how users actually prompt AI search: "best emergency plumbing
 * IN austin" but "emergency water heater NEAR cedar park". The matcher
 * regex `^/best-.+-(in|near)-.+/?$` accepts both connectors.
 *
 * The pattern length is bounded — service slug + location slug are each
 * truncated to 64 chars before joining. Pages with overly-long paths
 * are rejected at insert time by the path uniqueness check.
 */
export type SyntheticIntent = "best_top" | "affordable" | "emergency" | "specific_service";

export function buildPath(
  intent: SyntheticIntent,
  serviceSlug: string,
  locationSlug: string,
): string {
  const s = slugifyOne(serviceSlug).slice(0, 64);
  const l = slugifyOne(locationSlug).slice(0, 64);
  // Connector + prefix per intent. Stable so the URL is deterministic
  // across regenerations.
  switch (intent) {
    case "best_top":         return `/best-${s}-in-${l}`;
    case "affordable":       return `/affordable-${s}-in-${l}`;
    case "emergency":        return `/emergency-${s}-near-${l}`;
    case "specific_service": return `/${s}-in-${l}`;
  }
}

/**
 * Reverse-parse a path back to (intent, serviceSlug, locationSlug). Used
 * by the worker's path matcher to verify the URL shape before forwarding
 * to the server. Returns null when the path doesn't match any of the
 * known patterns — caller falls through to the next matcher (bot
 * detection, proxy-to-origin, etc).
 */
export function parsePath(path: string): {
  intent: SyntheticIntent;
  serviceSlug: string;
  locationSlug: string;
} | null {
  // Try the four shapes in order of specificity. Longest prefix first
  // so 'best-emergency-plumbing-in-austin' doesn't match the
  // 'specific_service' pattern (which is the catch-all).
  let m = path.match(/^\/best-([a-z0-9-]+?)-in-([a-z0-9-]+?)\/?$/);
  if (m) return { intent: "best_top", serviceSlug: m[1], locationSlug: m[2] };

  m = path.match(/^\/affordable-([a-z0-9-]+?)-in-([a-z0-9-]+?)\/?$/);
  if (m) return { intent: "affordable", serviceSlug: m[1], locationSlug: m[2] };

  m = path.match(/^\/emergency-([a-z0-9-]+?)-near-([a-z0-9-]+?)\/?$/);
  if (m) return { intent: "emergency", serviceSlug: m[1], locationSlug: m[2] };

  m = path.match(/^\/([a-z0-9-]+?)-in-([a-z0-9-]+?)\/?$/);
  if (m) {
    // The catch-all 'specific_service' pattern. Reject prefixes that
    // belong to the more-specific intents above so we don't double-match.
    if (m[1] === "best" || m[1] === "affordable") return null;
    return { intent: "specific_service", serviceSlug: m[1], locationSlug: m[2] };
  }

  return null;
}
