/* Perplexity-tuned variant: HTML article emphasizing inline `<strong>`
 * key facts + bulleted structure + aggregateRating JSON-LD (Perplexity
 * shows stars in answer cards from this).
 *
 * Hypothesis under test: Perplexity's extractor weights bold inline
 * markup higher (it surfaces them in the rendered card) and prefers
 * bulleted self-contained claims over running prose. */

import type { FormatVariant, RenderInput } from "../types.js";
import {
  buildBusinessJsonLd,
  buildFaqJsonLd,
  escapeHtml,
  jsonLdScript,
  mdBulletsToHtml,
} from "./shared.js";

export const perplexityHtml: FormatVariant = {
  id: "perplexity_html",
  label: "Perplexity-tuned HTML (bold inline, bullets, ProfessionalService + FAQPage JSON-LD)",
  optimizedFor: "perplexity",
  render: (input: RenderInput): string => {
    const { business, answerText, query, referralUrl } = input;
    const bizJsonLd = buildBusinessJsonLd(business, {
      type: "ProfessionalService",
      includeRating: true,
      includeAddress: true,
      includeKnowsAbout: true,
    });
    const faqJsonLd = buildFaqJsonLd(query, answerText);
    const body = mdBulletsToHtml(answerText);
    const title = `${business.name} — ${business.category ?? "Business"} in ${business.location ?? "the US"}`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml((business.description ?? "").slice(0, 155))}">
  <meta name="ai-generated" content="true">
  <meta property="og:title" content="${escapeHtml(business.name)}">
  <meta property="og:description" content="${escapeHtml((business.description ?? "").slice(0, 200))}">
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
</head>
<body>
  <article>
    <h1>${escapeHtml(business.name)}</h1>
    ${body}
    <p><a href="${escapeHtml(referralUrl)}" rel="nofollow">${escapeHtml(referralUrl)}</a></p>
  </article>
</body>
</html>`;
  },
};
