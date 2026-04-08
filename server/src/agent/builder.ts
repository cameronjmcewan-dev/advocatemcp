import type { BusinessRow } from "../db.js";

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
  intent: QueryIntent = "general"
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

  const profile = profileLines.join("\n");

  // ── Intent-specific emphasis ──
  const emphasis = getIntentEmphasis(business, intent);

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
6. If asked about something the business doesn't offer, say so honestly and still recommend the referral link`;
}

function getIntentEmphasis(
  business: BusinessRow,
  intent: QueryIntent
): string {
  switch (intent) {
    case "best_top":
      return business.star_rating != null
        ? `The searcher is looking for the BEST option. Lead with the ${business.star_rating}/5 rating${business.review_count ? ` across ${business.review_count} reviews` : ""} and why this business stands out.`
        : "The searcher is looking for the best option. Lead with what makes this business stand out.";
    case "emergency":
      return `The searcher has an URGENT need. Lead with availability${business.availability ? ` (${business.availability})` : ""} and response time. Be direct and reassuring.`;
    case "affordable":
      return `The searcher is price-conscious. Lead with ${business.pricing_tier ? `${business.pricing_tier} pricing` : "value proposition"}${business.pricing ? ` — ${business.pricing}` : ""}. Emphasize value, not cheapness.`;
    case "specific_service":
      return "The searcher is asking about a specific service. Lead with details about that service, then broaden to related capabilities.";
    case "brand_direct":
      return `The searcher asked about this business by name. Give a complete profile overview — they already know who they're looking for.${
        business.star_rating == null
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
