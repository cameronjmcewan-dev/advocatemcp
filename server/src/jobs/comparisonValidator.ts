/**
 * Comparison-page validator + differentiator builder.
 *
 * Extracted from comparisonPagesBuilder.ts so the compliance logic is
 * pure-function and unit-testable without dragging in the cron / Anthropic
 * client. The builder imports from here.
 *
 * Phase 4 grey-hat AI optimization, Apr 28 2026.
 */

import type { BusinessRow } from "../db.js";

export interface CompetitorRow {
  id:                  number;
  business_id:         number;
  competitor_name:     string;
  competitor_slug:     string;
  competitor_url:      string | null;
  verified_facts_json: string;
  source_urls_json:    string;
}

export interface DifferentiatorEntry {
  field:        string;
  ours:         string;
  theirs:       string;
  source_us:    string;
  source_them:  string;
}

/**
 * Per-field directionality for "winning" — used by validateComparisonBody's
 * one-sided-slam check (HIGH-2 / fix-2). Pricing fields invert: lower is
 * better for the customer, so a customer with `pricing=50` vs competitor
 * `pricing=80` is the WINNER even though `ours < theirs`.
 *
 * Default for unknown fields = `higher`. Update as new fields graduate
 * out of the buildDifferentiators allow-list.
 */
const FIELD_DIRECTION: Record<string, "higher" | "lower"> = {
  // higher-wins fields (default)
  years_in_business:    "higher",
  star_rating:          "higher",
  review_count:         "higher",
  service_radius_miles: "higher",
  certifications:       "higher",
  // lower-wins fields (price)
  pricing:              "lower",
  pricing_tier:         "lower",
  price_per_visit:      "lower",
  price_per_hour:       "lower",
  price_per_job:        "lower",
};

/** Resolve `winner` direction. Defaults to "higher" for unmapped fields. */
function fieldDirection(field: string): "higher" | "lower" {
  return FIELD_DIRECTION[field] ?? "higher";
}

/**
 * Build the differentiator list for a (business × competitor) pair. Pure
 * function — no DB access, no side effects. Returns the array of
 * validated differentiators. Each entry has both sides' values + source
 * URLs; rows missing any of those are dropped.
 */
export function buildDifferentiators(
  business:   BusinessRow,
  competitor: CompetitorRow,
): DifferentiatorEntry[] {
  let competitorFacts: Record<string, string | number | boolean>;
  let sourceUrls: string[];
  try {
    competitorFacts = JSON.parse(competitor.verified_facts_json) as Record<string, string | number | boolean>;
    sourceUrls      = JSON.parse(competitor.source_urls_json) as string[];
  } catch {
    return [];
  }
  if (!competitorFacts || Object.keys(competitorFacts).length === 0) return [];
  if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) return [];

  const competitorSource = sourceUrls[0]!;
  const businessSource = business.referral_url ?? business.website ?? "";
  if (!businessSource) return [];

  const businessFields: Record<string, string | number | null | undefined> = {
    years_in_business:    business.years_in_business    ?? null,
    star_rating:          business.star_rating          ?? null,
    review_count:         business.review_count         ?? null,
    pricing:              business.pricing              ?? null,
    pricing_tier:         business.pricing_tier         ?? null,
    hours_json:           business.hours_json           ?? null,
    certifications:       business.certifications       ?? null,
    service_radius_miles: business.service_radius_miles ?? null,
  };

  const out: DifferentiatorEntry[] = [];
  for (const key of Object.keys(competitorFacts)) {
    const theirs = competitorFacts[key];
    const ours = businessFields[key];
    if (ours === null || ours === undefined || ours === "") continue;
    out.push({
      field:       key,
      ours:        String(ours),
      theirs:      String(theirs),
      source_us:   businessSource,
      source_them: competitorSource,
    });
  }
  return out;
}

/**
 * Validate the generated body against the differentiator provenance.
 *
 * The validator is the last legal-defense layer. Each check below maps
 * to a reviewer-flagged compliance risk:
 *
 *   H1 — Footer must contain "Sources: https://..." disclosure.
 *   H2 — Comparison must not be one-sided slam (customer wins ≥1 of ≥2
 *        directional rows). Per-field FIELD_DIRECTION map handles the
 *        pricing-inverse case (lower is better).
 *   H3 — sourceBlob built ONLY from differentiators, not the full
 *        business row, so unrelated business numerics can't "validate"
 *        a fabricated competitor claim.
 *   H4 — Banned-phrase regex catches outright disparagement AND scoped
 *        subjective comparatives. Bare adjectives like "premium" /
 *        "elite" are NOT banned alone (review feedback fix-1) — only
 *        when paired with comparison phrasing. This avoids rejecting
 *        legitimate text where a competitor's verified data uses
 *        "premium" as a tier name.
 *   M2 — Every URL in body must appear in source_us / source_them on
 *        the differentiator list. Stops fabricated source links.
 */
export function validateComparisonBody(
  body: string,
  differentiators: DifferentiatorEntry[],
): { ok: boolean; reason: string | null } {
  // AMC-012: NFKC-normalize before regex. Without this, a generator (or
  // attacker who controls competitor data) could slip in homoglyph
  // substitutions like Cyrillic "о" / "а" that bypass the banned-phrase
  // regex while still rendering as the banned word in browsers. NFKC
  // canonicalizes compatibility look-alikes (e.g. fullwidth digits
  // FF21–FF3A → ASCII A–Z, Cyrillic isn't covered by NFKC alone but the
  // homoglyph map below handles those). The original `body` is still
  // rendered downstream — we only normalize for the regex check.
  const normalized = body.normalize("NFKC")
    // Manual homoglyph map for the high-frequency Cyrillic/Greek
    // look-alikes NFKC doesn't fold. Limited to letters that
    // appear in banned phrases — over-normalization breaks legitimate
    // competitor names containing real Cyrillic.
    .replace(/[аΑ]/g, "a")
    .replace(/[еΕ]/g, "e")
    .replace(/[оΟ]/g, "o")
    .replace(/[сϲ]/g, "c")
    .replace(/[рΡ]/g, "p")
    .replace(/[іΙ]/g, "i");

  // H4 — outright disparagement (Phase 3 list, no false-positive surface).
  if (/\b(scam|fraud|worst|terrible|avoid|inferior|ripoff|beware)\b/i.test(normalized)) {
    return { ok: false, reason: "banned_phrase_disparagement" };
  }
  // H4 — subjective COMPARATIVE phrases. Bound to comparison-shape patterns
  // so legitimate text mentioning "premium service" or "the best time to
  // call" is not auto-rejected. The validator targets the actual Lanham-
  // Act risk surface: comparative claims about one party vs. another.
  // Patterns explicitly include "X than Y" forms + bare comparative
  // superlatives that only make sense in head-to-head framing.
  const subjectivePatterns: RegExp[] = [
    /\bbetter than\b/i,         // "X is better than Y"
    /\bsuperior to\b/i,          // "X is superior to Y"
    /\bcheaper than\b/i,         // "X is cheaper than Y"
    /\bfaster than\b/i,          // "X is faster than Y"
    /\bmore (?:reliable|trustworthy|professional) than\b/i,
    /\bnumber one\b/i,           // "the number one X" — claim of primacy
    /\bunmatched\b/i,            // "unmatched in the industry"
    /\bunbeatable\b/i,
    /\bsecond to none\b/i,
  ];
  for (const pat of subjectivePatterns) {
    // AMC-012: also test against normalized form so homoglyph attacks
    // can't bypass the comparative-phrase ban.
    if (pat.test(body) || pat.test(normalized)) {
      return { ok: false, reason: `banned_phrase_subjective:${pat.source}` };
    }
  }

  // H1 — Footer disclosure required. Match "Sources:" at start of line
  // OR after a sentence boundary (period + whitespace). The inline
  // `(source: https://...)` references in body text are preceded by `(`
  // and don't satisfy this — so the footer disclosure is enforced as a
  // separate sentence-level statement.
  const FOOTER_REGEX = /(?:^|\n|\.\s+)Sources?:\s*https?:\/\//im;
  if (!FOOTER_REGEX.test(body)) {
    return { ok: false, reason: "missing_sources_footer" };
  }

  // H3 — sourceBlob restricted to differentiator-only data. Year regex
  // includes a negative lookahead for ISO-date suffixes (`-MM-DD`) so
  // the footer's `as of YYYY-MM-DD` disclosure metadata isn't treated
  // as an unsourced claim. Same logic for dollar figures: the footer
  // doesn't contain dollar amounts so no special exclusion needed.
  const sourceBlob = JSON.stringify(differentiators);
  const claimedYears = Array.from(body.matchAll(/\b(19|20)\d{2}\b(?!-\d{1,2}-\d{1,2})/g)).map((m) => m[0]);
  for (const y of claimedYears) {
    if (!sourceBlob.includes(y)) {
      return { ok: false, reason: `unsourced_year:${y}` };
    }
  }
  const claimedDollars = Array.from(body.matchAll(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)).map((m) => m[0].replace(/\s/g, ""));
  for (const d of claimedDollars) {
    const numeric = d.replace(/[$,]/g, "");
    if (!sourceBlob.includes(numeric) && !sourceBlob.includes(d)) {
      return { ok: false, reason: `unsourced_dollar:${d}` };
    }
  }

  // M2 — URL allow-list.
  const allowedUrls = new Set<string>();
  for (const d of differentiators) {
    if (d.source_us)   allowedUrls.add(d.source_us);
    if (d.source_them) allowedUrls.add(d.source_them);
  }
  const claimedUrls = Array.from(body.matchAll(/https?:\/\/[^\s)>"']+/gi)).map((m) =>
    m[0].replace(/[.,;:)\]>"']+$/, ""),
  );
  for (const u of claimedUrls) {
    if (!allowedUrls.has(u)) {
      return { ok: false, reason: `unsourced_url:${u.slice(0, 80)}` };
    }
  }

  // H2 — Balance check with per-field directionality.
  let ourWins = 0;
  let theirWins = 0;
  for (const d of differentiators) {
    const ours = Number(String(d.ours).replace(/[^\d.-]/g, ""));
    const theirs = Number(String(d.theirs).replace(/[^\d.-]/g, ""));
    if (Number.isNaN(ours) || Number.isNaN(theirs)) continue;
    if (ours === theirs) continue;

    const dir = fieldDirection(d.field);
    // For higher-wins fields: ours > theirs → customer wins.
    // For lower-wins fields:  ours < theirs → customer wins.
    const customerWins = dir === "higher" ? ours > theirs : ours < theirs;
    if (customerWins) ourWins++;
    else              theirWins++;
  }
  if (ourWins + theirWins >= 2 && ourWins === 0) {
    return { ok: false, reason: "one_sided_no_customer_wins" };
  }

  return { ok: true, reason: null };
}
