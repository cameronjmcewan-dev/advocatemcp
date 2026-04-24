/**
 * Frozen taxonomies for Layer 1 instrumentation.
 *
 * These enums are the source of truth for intent classification and
 * industry codes. They live in code, not the database, so Haiku (and any
 * other classifier) gets the full list inline in its prompt without a
 * separate round-trip. A new value = a migration, not a config tweak.
 *
 * Per the design principle in advocate-data-layer-vision.md:
 *   "Intent categories, suggestion types, industry codes — these should be
 *    enums frozen in code, not free-form text."
 */

// ── Intent ────────────────────────────────────────────────────────────────
// The wider vocabulary. v1 keyword values still get written to queries.intent
// for backwards compatibility — intent_v2 is the target column going forward.
// Haiku-classified values must come from this list; the classifier prompt
// includes it verbatim and the response is validated against it.

export const INTENT_V2 = [
  "brand",      // query names the business directly ("is Bloom & Stem open Sunday")
  "pricing",    // asks about cost, price, how much, quote
  "hours",      // asks when open, available, schedule
  "location",   // asks where, nearby, area, address
  "emergency",  // urgent/immediate/24-hr needs
  "comparison", // weighing two+ businesses or alternatives
  "service",    // asks about a specific offered service
  "reviews",    // asks about reputation, ratings, testimonials
  "contact",    // asks how to reach (phone, email, booking)
  "research",   // information-gathering, early-funnel curiosity
  "other",      // doesn't cleanly fit above — classifier must justify
] as const;

export type IntentV2 = typeof INTENT_V2[number];

/** Validate a string claimed to be an intent value. */
export function isIntentV2(s: unknown): s is IntentV2 {
  return typeof s === "string" && (INTENT_V2 as readonly string[]).includes(s);
}

// ── Industry codes ────────────────────────────────────────────────────────
// Deliberately broad, with "other" as a catch-all. We'd rather under-
// classify and have a real aggregate view than over-classify and end up
// with 50 categories that each hold two tenants.

export const INDUSTRY_CODES = [
  "food_beverage",      // restaurants, cafes, bars, food trucks
  "professional_svc",   // law, accounting, consulting, marketing
  "healthcare",         // medical, dental, chiro, mental health, PT
  "home_services",      // plumbing, HVAC, electrical, landscaping, cleaning
  "trades_construction", // general contractors, remodeling, flooring
  "retail",             // shops, boutiques, e-commerce
  "real_estate",        // brokers, property mgmt, agents
  "beauty_wellness",    // salons, spas, barbers, skincare
  "auto",               // repair, dealerships, detailing
  "education",          // tutoring, lessons, private schools
  "fitness",            // gyms, yoga studios, personal training
  "events",             // wedding vendors, venues, caterers, photographers
  "pets",               // vets, grooming, boarding, pet supplies
  "financial",          // financial planners, insurance, bookkeeping
  "technology",         // IT services, agencies, SaaS
  "other",              // final catch-all
] as const;

export type IndustryCode = typeof INDUSTRY_CODES[number];

/** Validate a string claimed to be an industry code. */
export function isIndustryCode(s: unknown): s is IndustryCode {
  return typeof s === "string" && (INDUSTRY_CODES as readonly string[]).includes(s);
}

/**
 * Map a free-form businesses.category string to a frozen industry_code.
 *
 * Returns "other" when no keyword hits — "other" is a real bucket, not a
 * missing value. Aggregate read paths that want to exclude it do so
 * explicitly (WHERE industry_code <> 'other').
 *
 * We match on substrings rather than exact equality so "Pediatric Dental
 * Practice" lands in healthcare without needing every variant enumerated.
 * Order matters — the first match wins — so more-specific patterns sit
 * above more-general ones.
 */
const INDUSTRY_KEYWORD_MAP: Array<[RegExp, IndustryCode]> = [
  // healthcare first — specific specialties shouldn't fall through to other
  [/dent(ist|al)|orthodont|endodont|periodont|oral surgeon/i, "healthcare"],
  [/\bvet(erinar)?\b|animal hospital|pet clinic/i,           "pets"],
  [/\b(md|doctor|physician|clinic|medical|nurse practitioner|chiropract|physical therap|mental health|psychol|psychiatr)\b/i, "healthcare"],

  // food
  [/restaur|pizz|caf[eé]|bakery|taqueria|bistro|diner|eatery|bar\b|brew|coffee|deli|food truck|caterer|catering/i, "food_beverage"],

  // home services
  [/plumb|hvac|heating|cooling|electric|landscap|lawn care|tree service|pest|clean(ing)?|handym|roofer|roofing|pressure wash|pool service/i, "home_services"],

  // trades / construction
  [/contractor|remodel|construction|flooring|tile|painter|carpentr|mason|fenc(e|ing)/i, "trades_construction"],

  // professional services
  [/\b(law|legal|attorney|cpa|accountant|bookkeep|tax prep|consult|agency|advertis|marketing|copywrit|email marketing)\b/i, "professional_svc"],

  // real estate
  [/real estate|property|realtor|land brokerage|broker|prop(erty)? mgmt|leasing/i, "real_estate"],

  // beauty & wellness
  [/salon|spa|barber|hairstyl|nail\b|lash|skincare|massage|aesthetic/i, "beauty_wellness"],

  // auto
  [/auto|mechanic|tire|detail(ing)?|\bcar\b|dealership|body shop/i, "auto"],

  // education
  [/school|tutor|lesson|academy|daycare|preschool|learning center/i, "education"],

  // fitness
  [/gym|fitness|yoga|pilates|crossfit|personal train|martial arts|boxing|cycling studio/i, "fitness"],

  // events
  [/wedding|event|venue|photograph|videograph|floris|florist|bouquet|dj\b/i, "events"],

  // pets (if not matched by vet above)
  [/\bpet\b|dog trainer|groom|boarding|kennel/i, "pets"],

  // financial
  [/financial|insurance|wealth|invest|retirement|mortgage|loan officer/i, "financial"],

  // technology
  [/software|saas|developer|web design|it services|managed services|cybersec/i, "technology"],

  // retail — catchall for "shop"/"store"/"boutique" that didn't land elsewhere
  [/\b(shop|store|boutique|retail|market)\b/i, "retail"],
];

export function classifyIndustry(category: string | null | undefined): IndustryCode {
  if (!category) return "other";
  const s = String(category);
  for (const [re, code] of INDUSTRY_KEYWORD_MAP) {
    if (re.test(s)) return code;
  }
  return "other";
}

// ── Outcome ───────────────────────────────────────────────────────────────
// Unified outcome column on queries. Independently settable — a single query
// may progress from "none" → "click" → "reservation" → "handoff" over time.
// The highest-fidelity outcome wins; the update path in the handler is
// monotonic (never downgrade).

export const OUTCOMES = [
  "none",         // no downstream signal recorded
  "click",        // /track redirect resolved the tagged URL
  "reservation",  // reserve_slot created a held row
  "confirmed",    // /a2a/confirm flipped a reservation to confirmed
  "handoff",      // initiate_handoff delivered successfully
  "error",        // agent returned an isError response
] as const;

export type Outcome = typeof OUTCOMES[number];

const OUTCOME_RANK: Record<Outcome, number> = {
  none: 0,
  click: 1,
  reservation: 2,
  confirmed: 3,
  handoff: 4,
  error: -1, // error is lateral — doesn't supersede a real outcome
};

/** Monotonic outcome update: returns the stronger of `current` vs `next`.
 *  'error' is lateral — it won't overwrite a real outcome (click/reservation/
 *  confirmed/handoff) but it DOES record onto an otherwise-empty row so we
 *  can see that something went wrong rather than leaving outcome='none'. */
export function mergeOutcome(current: Outcome | null | undefined, next: Outcome): Outcome {
  const c = (current as Outcome) || "none";
  if (next === "error") return c === "none" ? "error" : c;
  return OUTCOME_RANK[next] > OUTCOME_RANK[c] ? next : c;
}

// ── Claude pricing ────────────────────────────────────────────────────────
// Prices are in USD per 1M tokens. Keep this table explicit rather than
// hitting an API each call. When Anthropic updates pricing we bump this
// table in a single commit. Fallback is the Sonnet rate so unknown models
// still get a reasonable cost estimate rather than 0.

type ModelPricing = { input: number; output: number };

const MODEL_PRICING_USD_PER_MTOK: Record<string, ModelPricing> = {
  // Sonnet family
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  // Haiku family (much cheaper — use for intent classification)
  "claude-haiku-4-5":    { input: 0.8, output: 4 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  // Opus
  "claude-opus-4-7":  { input: 15, output: 75 },
  "claude-opus-4-6":  { input: 15, output: 75 },
};

const DEFAULT_PRICING = MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"];

/**
 * Compute cost in cents (integer) from token usage and model name.
 * Integer cents because that's what the schema stores and what finance
 * reports need. Fractional cents round half-up — a 1-cent query is still
 * a 1-cent query.
 */
export function computeCostCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = MODEL_PRICING_USD_PER_MTOK[model] ?? DEFAULT_PRICING;
  const usd = (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
  return Math.round(usd * 100);
}
