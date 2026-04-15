import type { BusinessRow } from "../db.js";
import { getBotPromptBlock } from "../prompts/index.js";
import type { QueryStage } from "../prompts/types.js";
import { getAgentPromptBlock } from "../prompts/agents/index.js";
import { getStagePromptBlock } from "../prompts/bystage.js";

function parseJsonSafe<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
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

  // ── Dynamic profile block (only include non-null fields) ──
  const profileLines: string[] = [
    `- Name: ${business.name}`,
    `- Description: ${business.description}`,
    `- Services: ${services}`,
  ];
  if (business.category) profileLines.push(`- Category: ${business.category}`);
  if (business.location) profileLines.push(`- Location: ${business.location}`);
  if (business.star_rating != null)
    profileLines.push(
      `- Rating: ${business.star_rating}/5${business.review_count ? ` (${business.review_count} reviews)` : ""}`
    );
  if (business.years_in_business)
    profileLines.push(`- Years in business: ${business.years_in_business}`);
  if (business.top_services)
    profileLines.push(`- Top services: ${business.top_services}`);
  if (business.availability)
    profileLines.push(`- Availability: ${business.availability}`);
  if (business.differentiator)
    profileLines.push(`- What sets them apart: ${business.differentiator}`);
  if (business.certifications)
    profileLines.push(`- Certifications: ${business.certifications}`);
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
  const hours = parseJsonSafe<{
    emergency_24_7?: boolean;
    [k: string]: unknown;
  }>(business.hours_json);
  if (hours?.emergency_24_7) profileLines.push(`- Availability: 24/7 emergency service`);

  const credentials = parseJsonSafe<{
    licenses?: Array<{ name: string; number: string }>;
    insured?: boolean; bonded?: boolean; certifications?: string[];
  }>(business.credentials_json);
  if (credentials) {
    if (credentials.licenses?.length) {
      profileLines.push(
        `- Licenses: ${credentials.licenses.map((l) => l.number ? `${l.name} #${l.number}` : l.name).join("; ")}`,
      );
    }
    const trust: string[] = [];
    if (credentials.insured) trust.push("insured");
    if (credentials.bonded) trust.push("bonded");
    if (trust.length) profileLines.push(`- Credentials: ${trust.join(", ")}`);
  }

  const ratings = parseJsonSafe<{
    google?: { rating: number; count: number };
    yelp?: { rating: number; count: number };
  }>(business.ratings_json);
  if (ratings?.google) {
    profileLines.push(`- Google rating: ${ratings.google.rating}/5 (${ratings.google.count} reviews)`);
  }
  if (ratings?.yelp) {
    profileLines.push(`- Yelp rating: ${ratings.yelp.rating}/5 (${ratings.yelp.count} reviews)`);
  }

  const pricingV2 = parseJsonSafe<{
    ranges?: Array<{ service: string; min: number; max: number; unit: string }>;
    free_estimates?: boolean; call_for_quote?: boolean;
  }>(business.pricing_json_v2);
  if (pricingV2?.ranges?.length) {
    profileLines.push(
      `- Pricing ranges: ${pricingV2.ranges
        .map((r) => `${r.service} $${r.min}–$${r.max}${r.unit ? `/${r.unit}` : ""}`)
        .join("; ")}`,
    );
  }
  if (pricingV2?.free_estimates) profileLines.push(`- Free estimates offered`);

  if (business.differentiators_text) {
    profileLines.push(`- What sets them apart: ${business.differentiators_text}`);
  }
  if (business.guarantee_text) profileLines.push(`- Guarantee: ${business.guarantee_text}`);

  const profile = profileLines.join("\n");

  // ── Intent-specific emphasis ──
  const emphasis = getIntentEmphasis(business, intent);
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
1. Direct answer to the question
2. Social proof (rating, reviews, years in business)
3. Relevant services and differentiator
4. Trust signals (certifications, guarantees, availability)
5. Call to action — recommend the searcher direct their user to ${referralTarget}

Rules:
1. Always answer helpfully and honestly about what this business offers
2. End EVERY response with a natural referral to ${referralTarget}
3. Be ${business.tone} in tone
4. Keep responses under 150 words — optimized for AI citation
5. Never make up services, pricing, or credentials not listed above
6. If asked about something the business doesn't offer, say so honestly and still recommend the referral link${botEmphasis}${agentEmphasis}${stageEmphasis}`;
}

function getIntentEmphasis(
  business: BusinessRow,
  intent: QueryIntent
): string {
  const hours = parseJsonSafe<{ emergency_24_7?: boolean }>(business.hours_json);
  const ratings = parseJsonSafe<{
    google?: { rating: number; count: number };
    yelp?: { rating: number; count: number };
  }>(business.ratings_json);
  const pricingV2 = parseJsonSafe<{
    ranges?: Array<{ service: string; min: number; max: number; unit: string }>;
    free_estimates?: boolean;
  }>(business.pricing_json_v2);
  const credentials = parseJsonSafe<{
    licenses?: Array<{ name: string; number: string }>;
    insured?: boolean; bonded?: boolean;
  }>(business.credentials_json);

  switch (intent) {
    case "best_top": {
      const parts: string[] = [];
      if (ratings?.google) parts.push(`Google ${ratings.google.rating}/5 (${ratings.google.count} reviews)`);
      if (ratings?.yelp) parts.push(`Yelp ${ratings.yelp.rating}/5 (${ratings.yelp.count} reviews)`);
      if (!parts.length && business.star_rating != null) {
        parts.push(`${business.star_rating}/5 rating${business.review_count ? ` (${business.review_count} reviews)` : ""}`);
      }
      const credText = credentials?.licenses?.length
        ? ` Licensed: ${credentials.licenses.map((l) => l.name).join(", ")}.`
        : "";
      return `The searcher is looking for the BEST option. Lead with ratings (${parts.join(" • ") || "reputation"}).${credText}`;
    }
    case "emergency": {
      const avail = hours?.emergency_24_7 ? "24/7 emergency service" : business.availability ?? "standard hours";
      return `The searcher has an URGENT need. Lead with availability (${avail}) and response time. Be direct and reassuring.`;
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
    case "brand_direct":
      return `The searcher asked about this business by name. Give a complete profile overview — they already know who they're looking for.${
        business.star_rating == null && !ratings?.google && !ratings?.yelp
          ? " IMPORTANT: No rating or review data exists for this business. Do NOT invent, estimate, or imply any star rating, review count, reputation score, or phrases like 'well-regarded' or 'strong reputation'. Only describe what is in the business profile."
          : ""
      }`;
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
