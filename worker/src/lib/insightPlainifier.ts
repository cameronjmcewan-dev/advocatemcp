/**
 * Plain-English rewrites for AI Insight recommendations.
 *
 * Why this exists
 * ---------------
 * Railway generates Pro/Enterprise AI Insights via Claude (see
 * server/src/routes/aiRecommendations.ts in the Railway repo). The
 * system prompt instructs Claude to be specific but does not enforce
 * plain language — output contains JSON-LD field names
 * (`foundingDate`, `customer_quotes_json`, `differentiators_text`),
 * AI/SEO jargon ("citation score", "per-engine variants"), and
 * platform name-drops. A non-technical business owner (the target
 * user) sees gibberish.
 *
 * This module rewrites Claude's output at the worker-proxy boundary
 * (apiAIRecommendations in worker/src/routes/portal.ts) before the
 * frontend ever sees it. Curated mapping table → deterministic,
 * free, fast. No Claude paraphrase call needed for v1.
 *
 * Plus a second concern: some `related_field` values reference
 * DERIVED fields (`foundingDate` is computed from `years_in_business`
 * at JSON-LD render time, per
 * server/src/experiments/formatJudge/formats/shared.ts:165-170).
 * Users click "Edit" expecting a Founded-date input, then can't find
 * it in the Business Profile editor. The redirect map remaps the
 * `related_field` key for derived fields so the action button lands
 * on the actual editable input via ACTION_FOCUS_ALIASES.
 */

/**
 * Recommendation shape (matches Railway's response schema). Permissive
 * — we don't own the type definition and Railway can add new fields
 * without breaking us. The mutation only touches string fields we
 * recognise.
 */
export interface PlainifiedRecommendation {
  title?: unknown;
  body?: unknown;
  reason?: unknown;
  related_field?: unknown;
  action_label?: unknown;
  action_url?: unknown;
  // Pass-through for any other fields Railway emits (expected_lift,
  // priority, expected_score_delta, etc.).
  [key: string]: unknown;
}

/**
 * Field-key → plain-English label. Used to rewrite occurrences of
 * raw schema keys in the title/body/reason copy. Mirrors
 * site/js/v2/profile.js's `prettyField()` map but covers more keys
 * because Railway's Claude can reference any field, not just the
 * ones the editor displays as "Open X →" buttons.
 */
const FIELD_LABELS: Record<string, string> = {
  foundingDate:            "your founding year",
  founding_date:           "your founding year",
  customer_quotes_json:    "customer reviews",
  customer_quotes:         "customer reviews",
  ratings_json:            "star ratings",
  ratings:                 "star ratings",
  credentials_json:        "your licenses and credentials",
  credentials:             "your licenses and credentials",
  differentiator:          "what makes you different",
  differentiators_text:    "what makes you different",
  differentiators:         "what makes you different",
  pricing_json_v2:         "your pricing details",
  pricing_tier:            "your pricing tier",
  hours_json:              "your business hours",
  service_radius_miles:    "your service radius",
  service_area_keywords:   "your service-area keywords",
  top_services:            "your top services",
  years_in_business:       "years in business",
  lead_routing_json:       "how leads reach you",
  case_stories_json:       "your case studies",
  guarantee_text:          "your guarantee",
  availability:            "your availability",
};

/**
 * Derived field → editable field redirect. When `related_field`
 * matches a key here, rewrite it to the value so the dashboard's
 * action button lands on the actual editable input (via
 * ACTION_FOCUS_ALIASES in site/js/v2/aiInsights.js).
 *
 * Add to this map whenever a derived field appears in Claude's
 * output AND has a direct-input equivalent the user can edit.
 */
const FIELD_REDIRECTS: Record<string, string> = {
  foundingDate:    "years_in_business",
  founding_date:   "years_in_business",
};

/**
 * Jargon-phrase rewrites. Applied to title/body/reason after the
 * field-label substitution so phrases that combine jargon + field
 * names get fully translated. Patterns are case-sensitive unless the
 * `i` flag is set explicitly (most are case-insensitive because
 * Claude's casing is inconsistent).
 *
 * Add entries here when real Claude output produces a new jargon
 * phrase. The contract test (insightPlainifier.test.ts) pins each
 * mapping; a manual scan of new production output is enough to
 * decide whether a phrase needs adding.
 */
const JARGON_REPLACEMENTS: Array<[RegExp, string]> = [
  // Platform / format jargon
  [/\bJSON-LD\b/g,                              "the structured info AI engines read"],
  [/\bschema\.org\b/gi,                         "the format AI engines understand"],
  [/\bstructured data\b/gi,                     "your structured business info"],
  // Citation / scoring jargon
  [/\bcitation score(?:s)?\b/gi,                "how often AI search names you"],
  [/\bcite rate(?:s)?\b/gi,                     "how often AI names you"],
  [/\bengine score(?:s)?\b/gi,                  "AI visibility scores"],
  [/\bper-engine variant(?:s)?\b/gi,            "how each AI tool sees your business"],
  [/\bper-engine\b/gi,                          "for each AI tool"],
  [/\bAI Overview\b/g,                          "Google's AI Overview"],
  // Content-quality jargon Claude emits. ORDER MATTERS — more specific
  // phrases must come before the generic versions, or the generic
  // pattern eats the substring before the specific one runs (e.g.
  // "low-trust signal" would become "low-credibility signals" if
  // "trust signal" fired first).
  [/\bhype-flagged\b/gi,                        "flagged as too promotional"],
  // Replacement uses "credibility" (not "trust") so the next pattern
  // in the array (`trust signal` → `credibility signals`) doesn't
  // cascade-rewrite this output. Same final wording for the user.
  [/\blow-trust signal(?:s)?\b/gi,              "weak credibility signal"],
  [/\btrust signal(?:s)?\b/gi,                  "credibility signals"],
  [/\bverbatim social proof\b/gi,               "real customer quotes"],
  [/\bsocial proof\b/gi,                        "customer testimonials"],
  // Action verbs Claude defaults to (too technical)
  [/\bPopulate ([^.,]+) to\b/gi,                "Add $1 so"],
  [/\bGrow ([^.,]+) beyond\b/gi,                "Get more $1 — at least"],
  // Quoted JSON values like `'2025'` or `\"2026\"` — strip the
  // quotes so they read as years rather than code literals. Run
  // this AFTER the field-name substitution so date contexts are
  // intact.
  [/'(\d{4})'/g,                                "$1"],
];

/**
 * Internal: rewrite a string by applying jargon phrases and field-
 * label substitutions. Order matters: jargon phrases first (so
 * "JSON-LD" → "the structured info..." happens before any field-key
 * pass), THEN field labels (so e.g. "Add customer_quotes_json"
 * becomes "Add customer reviews").
 */
function rewriteText(input: string): string {
  let text = input;
  // Pass 1: jargon phrases.
  for (const [pattern, replacement] of JARGON_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  // Pass 2: field-key labels. Word-boundary anchored so a token like
  // "ratings_json" matches but the substring "ratings" inside
  // "Verified ratings" doesn't get double-rewritten.
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const safe = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\b${safe}\\b`, "g"), label);
  }
  return text;
}

/**
 * Transform a single recommendation. Pure — does not mutate input;
 * returns a new object.
 *
 * Behavior:
 *   - title / body / reason: jargon phrases + field-key rewrites
 *   - related_field: redirect derived fields (e.g. foundingDate →
 *     years_in_business) so the action button lands on the editable
 *     input
 *   - All other fields: passed through unchanged
 */
export function plainifyRecommendation(rec: PlainifiedRecommendation): PlainifiedRecommendation {
  if (!rec || typeof rec !== "object") return rec;
  const out: PlainifiedRecommendation = { ...rec };

  // Redirect derived fields. Action label / URL frontend recomputes
  // from related_field via ACTION_FOCUS_ALIASES (site/js/v2/aiInsights.js
  // line ~137), so changing this key alone is enough to land the
  // user on the correct editable card. Action_url / action_label
  // may still embed the old field name in their text, so let the
  // text-rewrite pass below handle those.
  if (typeof out.related_field === "string" && FIELD_REDIRECTS[out.related_field]) {
    out.related_field = FIELD_REDIRECTS[out.related_field];
  }

  for (const key of ["title", "body", "reason", "action_label"] as const) {
    const value = out[key];
    if (typeof value === "string" && value.trim() !== "") {
      out[key] = rewriteText(value);
    }
  }

  return out;
}

/**
 * Transform a Railway recommendations payload in-place-ish. Returns
 * the payload (mutates `recommendations` array contents but keeps
 * the wrapper object intact). Best-effort: malformed payloads
 * (missing recommendations array, non-object entries) pass through
 * unchanged.
 */
export function plainifyRecommendationsPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.recommendations)) return payload;
  p.recommendations = p.recommendations.map((r) =>
    plainifyRecommendation(r as PlainifiedRecommendation),
  );
  return p;
}
