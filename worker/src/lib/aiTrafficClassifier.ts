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

// AI_MEDIUMS matches GA4's `sessionMedium` field.
//   - "ai" / "ai_overview" are Google's official AI-medium tags.
//   - "crawler" is Advocate's own UTM-medium tag, emitted by utmTag()
//     in worker/src/index.ts on every /track redirect from an AI bot
//     (utm_source=ai&utm_medium=crawler&utm_content=<botType>). When a
//     user clicks an AI-cited link that flows through /track, GA4
//     records sessionMedium="crawler" — which is genuinely AI-driven
//     traffic, so it belongs in the AI bucket alongside the official
//     mediums. Without this entry the classifier leaked Advocate's
//     own UTM-tagged AI clicks into "human", which was a real (small)
//     attribution gap observed in the 2026-05-23 audit.
export const AI_MEDIUMS = ["ai", "ai_overview", "crawler"] as const;

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
