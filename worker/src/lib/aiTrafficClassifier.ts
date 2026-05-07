/**
 * AI-vs-Human traffic classifier for GA4 daily-bucketed sessions.
 *
 * Pure function, no side effects. Consumed by ga4Sync at write time so we
 * never re-classify on read. Constants live here so they're easy to extend
 * as new AI search products launch.
 *
 * The classifier is intentionally generous on substring matches because GA4
 * source values arrive in many shapes — a host alone (`perplexity.ai`), a
 * full URL (`https://chat.openai.com/share/abc`), or a partial referrer
 * (`l.facebook.com`). Substring containment catches all three.
 */

export const AI_DOMAINS = [
  "chat.openai.com",
  "chatgpt.com",
  "perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "you.com",
  "phind.com",
  "kagi.com",
] as const;

export const AI_MEDIUMS = ["ai", "ai_overview"] as const;

export type TrafficClass = "ai" | "human";

/**
 * Classify a GA4 row by its session source and medium.
 *
 * @param source - GA4 sessionSource (e.g., "perplexity.ai", "google", "(direct)")
 * @param medium - GA4 sessionMedium (e.g., "referral", "organic", "ai")
 * @returns "ai" if either an AI medium or AI domain matches, else "human"
 */
export function classifyTrafficSource(
  source: string | null | undefined,
  medium: string | null | undefined,
): TrafficClass {
  const s = String(source ?? "").toLowerCase();
  const m = String(medium ?? "").toLowerCase();
  if ((AI_MEDIUMS as readonly string[]).includes(m)) return "ai";
  if (AI_DOMAINS.some((d) => s.includes(d))) return "ai";
  return "human";
}
