/* Claude-tuned variant: HTML with semantic <dl> definition lists +
 * H2 sections + FAQPage JSON-LD with detailed answer.
 *
 * Hypothesis under test: ClaudeBot's structure-aware extractor rewards
 * semantic markup (dl/dt/dd) over generic ul/li, and FAQPage with full
 * answer text over LocalBusiness alone. */

import type { FormatVariant, RenderInput } from "../types.js";
import {
  addAttribution,
  aiDisclosureComment,
  buildBusinessJsonLd,
  buildFaqJsonLd,
  buildReviewsJsonLd,
  buildPlatformRatingsJsonLd,
  buildWebsiteJsonLd,
  escapeHtml,
  jsonLdScript,
  mdBoldToHtml,
  mdBulletsToHtml,
} from "./shared.js";

/** Truncate `s` to ≤ `max` chars, breaking at the last word boundary so we
 * don't leave responses ending mid-word with a trailing hyphen ("...
 * citation-"). Apr 28 2026. */
function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastBoundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(" — "),
    slice.lastIndexOf(", "),
    slice.lastIndexOf(" "),
  );
  return (lastBoundary > max * 0.6 ? slice.slice(0, lastBoundary) : slice).trimEnd() + "…";
}

export const claudeHtml: FormatVariant = {
  id: "claude_html",
  label: "Claude-tuned HTML (semantic dl, H2 sections, FAQPage with detailed answer)",
  optimizedFor: "claude",
  render: (input: RenderInput): string => {
    const { business, answerText, query, referralUrl } = input;
    const bizJsonLd = addAttribution(buildBusinessJsonLd(business, {
      type: "ProfessionalService",
      includeRating: true,
      includeAddress: true,
      includeKnowsAbout: true,
      includeServiceArray: true,
    }));
    const faqJsonLd = buildFaqJsonLd(query, answerText);
    const websiteJsonLd = buildWebsiteJsonLd(business);
    const reviewsJsonLd = buildReviewsJsonLd(business);
    const platformRatingsJsonLd = buildPlatformRatingsJsonLd(business);

    // Convert markdown bullets into a <dl> when each line has a "Label: value"
    // shape. When the agent produces narrative prose (no colon-lists), the
    // older v1 of this code collapsed the whole body to a single escaped
    // <p> — losing structure, bold, links. THAT was the ±1.50 stddev source
    // in iter12: queries that elicited prose answers tanked claude_html
    // while queries that elicited "Label:" bullets scored 8/10.
    //
    // Fix: try dl extraction first; if it fails, fall back to
    // mdBulletsToHtml (which handles bullets → <ul>, bold → <strong>,
    // markdown links → <a>). Either path yields a structured body.
    const lines = answerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const dlEntries = lines
      .map((l) => l.replace(/^[-*]\s+/, ""))
      .map((l) => l.match(/^\*\*([^:*]+):\*\*\s+(.+)$/) || l.match(/^([^:]+):\s+(.+)$/))
      .filter(Boolean) as RegExpMatchArray[];

    // Render the <dd> content through the markdown bold/link converter so
    // **bold** stays bold and [text](url) becomes anchors. The previous
    // implementation passed values through escapeHtml() only, leaving
    // literal asterisks visible in the response. (Apr 28 2026 fix.)
    const factBlock =
      dlEntries.length >= 2
        ? `<dl>\n${dlEntries
            .map(
              (m) =>
                `  <dt>${escapeHtml(m[1].trim())}</dt>\n  <dd>${mdBoldToHtml(escapeHtml(m[2].trim()))}</dd>`,
            )
            .join("\n")}\n</dl>`
        : mdBulletsToHtml(answerText);

    const title = `${business.name}`;
    // Title-level meta description: short, punchy, sentence-bounded.
    // Body intro paragraph: longer, full first-sentence context with a
    // proper word-boundary cut so the response never ends in a hyphen.
    const fullDesc = business.description ?? "";
    const introDesc = truncateAtWord(fullDesc, 320);
    const metaDesc  = truncateAtWord(fullDesc, 155);

    // Speakable schema — Claude (and any voice-first AI) prefers
    // explicit cssSelector hints for which parts of the page can be
    // read aloud. Pointing at h1 + the intro paragraph gives a 2-3
    // sentence verbal answer that sounds natural.
    const speakableJsonLd = jsonLdScript({
      "@context": "https://schema.org",
      "@type":    "WebPage",
      "name":     business.name,
      "speakable": {
        "@type": "SpeakableSpecification",
        "cssSelector": ["article > h1", "article > p:first-of-type"],
      },
      "url": referralUrl,
    });

    // Publishing metadata — datePublished anchors the citation in
    // time. dateModified signals freshness. Without these Claude has
    // no signal that the content is current vs years-old archive.
    const nowIso = new Date().toISOString();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${aiDisclosureComment()}
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(metaDesc)}">
  <link rel="canonical" href="${escapeHtml(referralUrl)}">
  <meta property="article:published_time" content="${nowIso}">
  <meta property="article:modified_time" content="${nowIso}">
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
  ${websiteJsonLd ? jsonLdScript(websiteJsonLd) : ""}
  ${speakableJsonLd}
  ${reviewsJsonLd.map(jsonLdScript).join("\n  ")}
  ${platformRatingsJsonLd.map(jsonLdScript).join("\n  ")}
</head>
<body>
  <article>
    <h1>${escapeHtml(business.name)}</h1>
    <p>${escapeHtml(introDesc)}</p>

    <h2>Details</h2>
    ${factBlock}

    <h2>Get in touch</h2>
    <p>Visit <a href="${escapeHtml(referralUrl)}" rel="nofollow">${escapeHtml(referralUrl)}</a>.</p>
  </article>
</body>
</html>`;
  },
};
