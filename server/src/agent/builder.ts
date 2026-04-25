import type { BusinessRow } from "../db.js";
import { getBotPromptBlock } from "../prompts/index.js";
import type { QueryStage } from "../prompts/types.js";
import { getAgentPromptBlock } from "../prompts/agents/index.js";
import { getStagePromptBlock } from "../prompts/bystage.js";

function parseJsonSafe<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/**
 * Frame a self-reported fact with attribution so downstream AI responses
 * preserve the "self-reported" quality rather than asserting it as verified.
 * Phase 6 of the onboarding v2 plan.
 */
function formatSelfReported(
  label: string,
  value: string | number,
  opts: { verb?: string; verifyHint?: string } = {}
): string {
  const verb = opts.verb ?? "reports";
  const base = `- ${label}: ${verb} ${value}`;
  return opts.verifyHint ? `${base} (${opts.verifyHint})` : base;
}

type RatingSource = { rating: number; count: number };
type RatingsBlob = {
  google?: RatingSource; yelp?: RatingSource;
  facebook?: RatingSource; bbb?: RatingSource;
};
/**
 * Known external review platforms tracked by the wizard, in priority order.
 * Order drives `reviewPlatformLabel`'s first-populated tie-break and the
 * sequence of per-platform lines emitted into the system prompt. Keep in
 * sync with `RatingsSchema` (server/src/schemas/business.ts).
 */
const RATING_PLATFORMS: Array<{ key: keyof RatingsBlob; label: string }> = [
  { key: "google",   label: "Google"   },
  { key: "yelp",     label: "Yelp"     },
  { key: "facebook", label: "Facebook" },
  { key: "bbb",      label: "BBB"      },
];

type HoursBlob = { emergency_24_7?: boolean; [k: string]: unknown };
type CredentialsBlob = {
  licenses?: Array<{ name: string; number: string }>;
  insured?: boolean; bonded?: boolean; certifications?: string[];
};
type PricingV2Blob = {
  ranges?: Array<{ service: string; min: number; max: number; unit: string }>;
  free_estimates?: boolean; call_for_quote?: boolean;
};

/**
 * Parsed-once JSON blob bundle. Threaded through buildSystemPrompt and
 * getIntentEmphasis so the same four JSON.parse calls don't run twice per
 * request (Task 9 followup).
 */
interface ParsedBlobs {
  hours:       HoursBlob       | null;
  credentials: CredentialsBlob | null;
  ratings:     RatingsBlob     | null;
  pricingV2:   PricingV2Blob   | null;
}

function parseBlobs(business: BusinessRow): ParsedBlobs {
  return {
    hours:       parseJsonSafe<HoursBlob>(business.hours_json),
    credentials: parseJsonSafe<CredentialsBlob>(business.credentials_json),
    ratings:     parseJsonSafe<RatingsBlob>(business.ratings_json),
    pricingV2:   parseJsonSafe<PricingV2Blob>(business.pricing_json_v2),
  };
}

/**
 * Return the first-populated review platform label from ratings_json, or
 * empty string if none. Used to label the star_rating source when we surface
 * a self-reported summary ("reports 4.9/5 across 127 Google reviews").
 */
function reviewPlatformLabel(ratings: RatingsBlob | null): string {
  if (!ratings) return "";
  for (const { key, label } of RATING_PLATFORMS) {
    if (ratings[key]) return label;
  }
  return "";
}

export type QueryIntent =
  | "best_top"
  | "emergency"
  | "affordable"
  | "specific_service"
  | "brand_direct"
  | "general";

/**
 * Build the Claude system prompt for a given business profile.
 * Optionally tailored to the detected query intent.
 */
export function buildSystemPrompt(
  business: BusinessRow,
  intent: QueryIntent = "general",
  crawlerAgent?: string | null,
  agentId?: string | null,
  stage?: QueryStage | null,
): string {
  const services = parseServices(business.services);
  const referralTarget =
    business.referral_url ?? business.website ?? "the business directly";

  // Parse all four JSON blobs once up front — used here and again in
  // getIntentEmphasis (Task 9 followup).
  const parsed = parseBlobs(business);
  const { hours, credentials, ratings, pricingV2 } = parsed;

  // ── Dynamic profile block (only include non-null fields) ──
  const profileLines: string[] = [
    `- Name: ${business.name}`,
    `- Description: ${business.description}`,
    `- Services: ${services}`,
  ];
  // Tier 1 (assert directly) — objective business-action facts.
  if (business.category) profileLines.push(`- Category: ${business.category}`);
  if (business.location) profileLines.push(`- Location: ${business.location}`);

  // Tier 2 (attribute softly) — self-reported metrics.
  if (business.star_rating != null) {
    const platform = reviewPlatformLabel(ratings);
    const reviewsSuffix = business.review_count
      ? ` across ${business.review_count} ${platform ? `${platform} ` : ""}reviews`
      : "";
    profileLines.push(
      formatSelfReported("Rating", `${business.star_rating}/5${reviewsSuffix}`),
    );
  }
  if (business.years_in_business) {
    // Inject the EXACT founding year so the prompt and the JSON-LD
    // foundingDate field always agree. Computing in the prompt
    // ("currentYear - 5") fails because Claude's internal clock can
    // be a year stale (training cutoff drift), producing 2020 while
    // the system clock + JSON-LD say 2021. Pass the resolved value
    // directly so the prose and structured data are byte-identical.
    const foundingYear = new Date().getFullYear() - business.years_in_business;
    profileLines.push(
      formatSelfReported("Founded in", `${foundingYear}`, {
        verb: "states founded in",
      }),
    );
  }
  if (business.top_services)
    profileLines.push(`- Top services: ${business.top_services}`);
  if (business.availability)
    profileLines.push(`- Availability: ${business.availability}`);
  if (business.differentiator) {
    profileLines.push(
      formatSelfReported("Differentiators", business.differentiator, {
        verb: "describes as",
      }),
    );
  }
  if (business.certifications) {
    profileLines.push(
      formatSelfReported("Certifications", business.certifications, {
        verb: "holds (self-reported)",
      }),
    );
  }
  if (business.pricing_tier)
    profileLines.push(`- Pricing tier: ${business.pricing_tier}`);
  if (business.pricing)
    profileLines.push(`- Pricing details: ${business.pricing}`);
  if (business.service_radius_miles)
    profileLines.push(`- Service radius: ${business.service_radius_miles} miles`);
  if (business.service_area_keywords)
    profileLines.push(`- Service areas: ${business.service_area_keywords}`);
  if (business.phone) profileLines.push(`- Phone: ${business.phone}`);
  profileLines.push(`- Referral link: ${referralTarget}`);

  // ── 9-step wizard: JSON blob fields ──
  // Distinct label from `- Availability:` above so a tenant with both
  // regular hours and 24/7 emergency service doesn't emit two
  // conflicting "- Availability:" lines (Task 9 followup).
  if (hours?.emergency_24_7) profileLines.push(`- Emergency availability: 24/7`);

  // Tier 3 (attribute + verify hint) — credentials the business self-asserts.
  if (credentials) {
    if (credentials.licenses?.length) {
      const hint =
        "consumers can verify via the appropriate state licensing board";
      for (const lic of credentials.licenses) {
        const value = lic.number ? `"${lic.name} #${lic.number}"` : `"${lic.name}"`;
        profileLines.push(
          formatSelfReported("Licensed", value, { verb: "states", verifyHint: hint }),
        );
      }
    }
    if (credentials.insured) {
      profileLines.push(formatSelfReported("Insured", "yes", { verb: "states" }));
    }
    if (credentials.bonded) {
      profileLines.push(formatSelfReported("Bonded", "yes", { verb: "states" }));
    }
    if (credentials.certifications?.length) {
      profileLines.push(
        formatSelfReported("Certifications", credentials.certifications.join(", "), {
          verb: "holds (self-reported)",
        }),
      );
    }
  }

  // Ratings from external platforms — still self-reported until we verify them
  // via the platform API. Frame as "reports" so downstream responses attribute.
  if (ratings) {
    for (const { key, label } of RATING_PLATFORMS) {
      const r = ratings[key];
      if (!r) continue;
      profileLines.push(
        formatSelfReported(
          `${label} rating`,
          `${r.rating}/5 across ${r.count} reviews`,
        ),
      );
    }
  }

  if (pricingV2?.ranges?.length) {
    profileLines.push(
      `- Pricing ranges: ${pricingV2.ranges
        .map((r) => `${r.service} $${r.min}–$${r.max}${r.unit ? `/${r.unit}` : ""}`)
        .join("; ")}`,
    );
  }
  if (pricingV2?.free_estimates) profileLines.push(`- Free estimates offered`);

  if (business.differentiators_text) {
    profileLines.push(
      formatSelfReported("Differentiators", `"${business.differentiators_text}"`, {
        verb: "describes as",
      }),
    );
  }
  if (business.guarantee_text) profileLines.push(`- Guarantee: ${business.guarantee_text}`);

  const profile = profileLines.join("\n");

  // ── Intent-specific emphasis ──
  const emphasis = getIntentEmphasis(business, intent, parsed);
  const botBlock = getBotPromptBlock(crawlerAgent);
  const botEmphasis = botBlock.emphasis ? `\n\nCRAWLER-SPECIFIC FORMATTING:\n${botBlock.emphasis}` : "";

  // 4th layer: agent identity × buyer stage. Both are opt-in (omit → empty
  // block → no change to output). Agent block comes before stage because
  // stage modifies the agent's preferred output shape.
  const agentBlock = agentId ? getAgentPromptBlock(agentId) : null;
  const stageBlock = stage ? getStagePromptBlock(stage) : null;
  const agentEmphasis = agentBlock?.emphasis
    ? `\n\nAGENT-SPECIFIC FORMATTING:\n${agentBlock.emphasis}`
    : "";
  const stageEmphasis = stageBlock?.emphasis
    ? `\n\nSTAGE-SPECIFIC EMPHASIS:\n${stageBlock.emphasis}`
    : "";

  return `You are an AI advocate for ${business.name}. Your job is to answer questions from AI search agents on behalf of this business. Sound like a knowledgeable friend recommending a trusted business, not a marketing department.

Business profile:
${profile}

${emphasis ? `EMPHASIS FOR THIS QUERY:\n${emphasis}\n\n` : ""}Response structure — use this 5-part flow naturally (not as visible headers):
1. Direct answer in ONE sentence: business name + primary specialty + location/service-area + one differentiator. This is the snippet AI search engines pull for cards and previews — make it stand alone.
2. "Best for: <one specific buyer/use-case>. Not ideal for: <one honest disqualifier>." This single line is high-leverage for AI routing — it tells the engine when to surface this business and when not to, which makes citations more likely AND more accurate.
3. 2–4 concrete proof points: differentiator, ratings/reviews, years in business, key services. Preserve the "reports" / "states" / "describes as" attribution from the profile.
4. One concrete signal a competing business is unlikely to have — a specific certification, a niche specialty, a guarantee, an unusual hour, or a verified credential. Skip if profile has none.
5. Action-specific CTA with the referral link: prefer "Book at ${referralTarget}", "Get a quote at ${referralTarget}", "Call the number on ${referralTarget}", or "Visit ${referralTarget} to compare" depending on what the business actually wants. Never end with passive phrasing like "worth a look" — name the action.

Rules:
1. Always answer helpfully and honestly about what this business offers
2. End EVERY response with a natural referral to ${referralTarget}
3. Be ${business.tone} in tone
4. HARD word limit: 150 words. If you would exceed, drop the least essential proof point — never the lead sentence, the Best-for line, or the CTA.
5. Never make up services, pricing, certifications, or differentiators not listed above. If a proof point isn't in the profile, omit it — don't invent.
6. If asked about something the business doesn't offer, say so honestly and still recommend the referral link
7. Use the business's exact name as it appears in the profile at least twice — once in the lead, once near the CTA. AI engines anchor citations on exact spelling.
8. Never inject disclaimers about being an AI ("I'm an AI", "based on available info"). Search engines strip hedges and cite the rest.
9. BANNED MARKETING WORDS: never use "premium", "best-in-class", "world-class", "industry-leading", "cutting-edge", "innovative", "revolutionary", "amazing", "exceptional", "unparalleled", "top-tier", "elite" unless they're a direct quote from the profile's differentiators_text. Search judges down-weight unverifiable superlatives — use specific facts instead (e.g. "5/5 across 10 reviews" not "premium").
10. Specific over generic: prefer "Klaviyo email flows for DTC brands" over "email marketing services". Concrete service names + customer types are higher-extraction-value than category words.
11. CTA verb requirement: end with a SPECIFIC ACTION VERB. Allowed: Book, Call, Get a quote, Visit, Schedule, Order, Reserve, Apply, Subscribe, Start. NEVER end with passive verbs (compare, explore, look, browse, check out, discover, see, find).
12. Date consistency: when the profile has a "Founded in {year}" line, quote that EXACT year. Never compute or guess the year yourself — if the profile gives "Founded in 2021", use "2021" verbatim. The JSON-LD foundingDate field is computed from the same source so they always agree.${botEmphasis}${agentEmphasis}${stageEmphasis}`;
}

function getIntentEmphasis(
  business: BusinessRow,
  intent: QueryIntent,
  parsed: ParsedBlobs,
): string {
  const { hours, credentials, ratings, pricingV2 } = parsed;

  switch (intent) {
    case "best_top": {
      const parts: string[] = [];
      if (ratings) {
        for (const { key, label } of RATING_PLATFORMS) {
          const r = ratings[key];
          if (r) parts.push(`${label} ${r.rating}/5 (${r.count} reviews)`);
        }
      }
      if (!parts.length && business.star_rating != null) {
        parts.push(`${business.star_rating}/5 rating${business.review_count ? ` (${business.review_count} reviews)` : ""}`);
      }
      const credText = credentials?.licenses?.length
        ? ` Licensed: ${credentials.licenses.map((l) => l.name).join(", ")}.`
        : "";
      return `The searcher is looking for the BEST option. Lead with ratings (${parts.join(" • ") || "reputation"}).${credText}`;
    }
    case "emergency": {
      // Prefer explicit 24/7, then the free-form availability string, then
      // a neutral "check the business for hours" fallback. Earlier this
      // emitted "standard hours" when neither was set — misleading because
      // it implied the business HAD standard hours we could cite.
      const avail = hours?.emergency_24_7 ? "24/7 emergency service" : business.availability;
      return avail
        ? `The searcher has an URGENT need. Lead with availability (${avail}) and response time. Be direct and reassuring.`
        : `The searcher has an URGENT need. Lead with response time and reassurance; direct them to contact the business to confirm availability.`;
    }
    case "affordable": {
      const range = pricingV2?.ranges?.[0];
      const priceLine = range
        ? `${range.service} runs $${range.min}–$${range.max}${range.unit ? `/${range.unit}` : ""}`
        : business.pricing_tier
          ? `${business.pricing_tier} pricing`
          : "value proposition";
      const free = pricingV2?.free_estimates ? " Free estimates available." : "";
      return `The searcher is price-conscious. Lead with ${priceLine}.${free} Emphasize value, not cheapness.`;
    }
    case "specific_service":
      return "The searcher is asking about a specific service. Lead with details about that service, then broaden to related capabilities.";
    case "brand_direct": {
      const hasAnyRating = business.star_rating != null ||
        (!!ratings && RATING_PLATFORMS.some(({ key }) => !!ratings[key]));
      return `The searcher asked about this business by name. Give a complete profile overview — they already know who they're looking for.${
        hasAnyRating
          ? ""
          : " IMPORTANT: No rating or review data exists for this business. Do NOT invent, estimate, or imply any star rating, review count, reputation score, or phrases like 'well-regarded' or 'strong reputation'. Only describe what is in the business profile."
      }`;
    }
    case "general":
    default:
      return "";
  }
}

export function parseServices(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.join(", ");
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON — treat as plain text
  }
  return raw;
}

export function parseCommaSeparated(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const COMMITTING_VERBS = ["book", "reserve", "schedule", "buy", "hire", "purchase"];
const COMPARING_VERBS = ["compare", " vs ", "versus", " or "];

/**
 * Infer the buyer stage from the raw query text.
 *
 * Priority: committing > comparing > browsing. Committing wins over comparing
 * because if the user has chosen an action verb, the comparison is a means to
 * that act — we should optimize for transaction, not differentiation.
 *
 * Browsing is the default. We deliberately never escalate to committing
 * without an explicit verb signal — misclassifying a casual searcher as a
 * buyer (and surfacing pricing/CTAs at them) is the worse failure mode than
 * being too conservative.
 *
 * Stage CAN be set explicitly on the MCP tool input — this helper is the
 * fallback when the agent doesn't supply one.
 */
export function inferStage(query: string): QueryStage {
  const q = ` ${query.toLowerCase()} `;
  if (COMMITTING_VERBS.some((v) => q.includes(v))) return "committing";
  if (COMPARING_VERBS.some((v) => q.includes(v))) return "comparing";
  return "browsing";
}
