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
  mdBulletsToHtml,
} from "./shared.js";

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

    const factBlock =
      dlEntries.length >= 2
        ? `<dl>\n${dlEntries
            .map(
              (m) =>
                `  <dt>${escapeHtml(m[1].trim())}</dt>\n  <dd>${escapeHtml(m[2].trim())}</dd>`,
            )
            .join("\n")}\n</dl>`
        : mdBulletsToHtml(answerText);

    const title = `${business.name}`;
    const desc = (business.description ?? "").slice(0, 200);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${aiDisclosureComment()}
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc.slice(0, 155))}">
  <link rel="canonical" href="${escapeHtml(referralUrl)}">
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
  ${websiteJsonLd ? jsonLdScript(websiteJsonLd) : ""}
  ${reviewsJsonLd.map(jsonLdScript).join("\n  ")}
  ${platformRatingsJsonLd.map(jsonLdScript).join("\n  ")}
</head>
<body>
  <article>
    <h1>${escapeHtml(business.name)}</h1>
    <p>${escapeHtml(desc)}</p>

    <h2>Details</h2>
    ${factBlock}

    <h2>Get in touch</h2>
    <p>Visit <a href="${escapeHtml(referralUrl)}" rel="nofollow">${escapeHtml(referralUrl)}</a>.</p>
  </article>
</body>
</html>`;
  },
};
