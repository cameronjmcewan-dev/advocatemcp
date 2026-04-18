/**
 * Deterministic descriptor extraction for Competitor Radar answers.
 *
 * Given the natural-language text returned by a provider (Perplexity,
 * OpenAI) alongside a cited tenant's business name, find sentences that
 * mention the tenant and scan them against a fixed descriptor vocabulary.
 * Output is a sorted, deduplicated string[] of matched descriptors.
 *
 * v1 intentionally avoids LLM calls: the vocabulary is small, the matches
 * are regex-word-boundary, and drift is observable (bad matches show up
 * as either missing descriptors or descriptors the tenant cares about
 * being absent). If the vocabulary proves too thin after a month of real
 * data, revisit with an LLM-based extractor.
 *
 * Vocabulary axes (each axis has positive/negative poles so we can show
 * mixed-signal tenants — "affordable but slow" — honestly):
 *
 *  - quality:   reliable, professional, trusted, reputable · unreliable, unprofessional
 *  - price:     affordable, fair · expensive, overpriced
 *  - speed:     fast, responsive, prompt · slow
 *  - expertise: experienced, expert, specialized · inexperienced
 *  - service:   friendly, helpful, thorough · rude
 *
 * 22 descriptors total. Anchor each with case-insensitive \b word boundaries
 * so "affordable" doesn't collide with "unaffordable" (negation case — we
 * don't attempt negation parsing in v1; bare lexical match only).
 */

const DESCRIPTORS: readonly string[] = [
  // quality
  "reliable", "professional", "trusted", "reputable",
  "unreliable", "unprofessional",
  // price
  "affordable", "fair", "expensive", "overpriced",
  // speed
  "fast", "responsive", "prompt", "slow",
  // expertise
  "experienced", "expert", "specialized", "inexperienced",
  // service
  "friendly", "helpful", "thorough", "rude",
];

/**
 * Split answer text into rough sentences. Good enough for descriptor
 * extraction — we don't need linguistically-perfect segmentation.
 * Splits on . ! ? followed by whitespace/end; preserves ordering.
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/(?<=[.!?])\s+|\n+/g);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Escape regex special characters in a business name so it can be used
 * inside a RegExp without accidentally matching as a pattern.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a case-insensitive regex that matches the business name with word
 * boundaries only on the sides that start/end with a word character. This
 * lets "Acme" get \b-guarded (so "Place" doesn't match "ace") while a name
 * like "C++ Shop (Austin)" — which ends in a non-word char — still matches
 * even though \b wouldn't fire between ')' and ' '.
 */
function nameRegex(name: string): RegExp {
  const trimmed = name.trim();
  const prefix  = /^\w/.test(trimmed) ? "\\b" : "";
  const suffix  = /\w$/.test(trimmed) ? "\\b" : "";
  return new RegExp(prefix + escapeRegex(trimmed) + suffix, "i");
}

/**
 * Return descriptors found in sentences that mention the business name.
 * - Case-insensitive match on both the name and each descriptor
 * - Descriptor match is word-boundary anchored so "fast" doesn't match "breakfast"
 * - Business-name \b is applied only on word-char sides (see nameRegex)
 * - Deduplicated and sorted alphabetically for stable output
 * - Empty array when name is blank, answer is blank, or no matches found
 */
export function extractSentiment(answerText: string, businessName: string): string[] {
  if (!answerText || !businessName) return [];

  const nameRe = nameRegex(businessName);
  const sentences = splitSentences(answerText).filter((s) => nameRe.test(s));
  if (sentences.length === 0) return [];

  const joined = sentences.join(" ");
  const found = new Set<string>();
  for (const d of DESCRIPTORS) {
    const re = new RegExp(`\\b${d}\\b`, "i");
    if (re.test(joined)) found.add(d);
  }

  return [...found].sort();
}

/**
 * Read-only accessor so tests and callers can assert against the vocabulary
 * without re-importing the private constant.
 */
export function descriptorVocabulary(): readonly string[] {
  return DESCRIPTORS;
}
