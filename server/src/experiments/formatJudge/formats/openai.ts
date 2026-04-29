/* ChatGPT-tuned variant: HTML with conversational paragraph prose +
 * rich entity-focused JSON-LD (ProfessionalService with knowsAbout +
 * service array) + OpenGraph for link-out previews.
 *
 * Hypothesis under test: ChatGPT search favors quotable paragraph
 * passages and rich entity disambiguation via JSON-LD. */

import type { FormatVariant, RenderInput } from "../types.js";
import {
  addAttribution,
  aiDisclosureComment,
  buildAiInstructionAside,
  buildBusinessJsonLd,
  buildFaqJsonLd,
  buildReviewsJsonLd,
  buildPlatformRatingsJsonLd,
  buildWebsiteJsonLd,
  escapeHtml,
  jsonLdScript,
  mdBoldToHtml,
  mergeFaqsForRenderer,
  platformAlternateLinks,
} from "./shared.js";

export const openaiHtml: FormatVariant = {
  id: "openai_html",
  label: "ChatGPT-tuned HTML (prose paragraphs, rich entity JSON-LD, OpenGraph)",
  optimizedFor: "openai",
  render: (input: RenderInput): string => {
    const { business, answerText, query, referralUrl, mentionsGraph } = input;
    const bizJsonLd = addAttribution(buildBusinessJsonLd(business, {
      type: "ProfessionalService",
      includeRating: true,
      includeAddress: true,
      includeKnowsAbout: true,
      includeServiceArray: true,
      mentionsGraph,
    }));
    // Phase 1 grey-hat: merge active query/answer with pre-generated
    // leading-question Q&As (faqs_json on the business).
    const faqJsonLd = buildFaqJsonLd(mergeFaqsForRenderer(business, query, answerText));
    const websiteJsonLd = buildWebsiteJsonLd(business);
    const reviewsJsonLd = buildReviewsJsonLd(business);
    const platformRatingsJsonLd = buildPlatformRatingsJsonLd(business);

    // Strip markdown bullets — ChatGPT prefers prose. Convert each "- ..." line
    // into a sentence pulled into the next paragraph.
    const proseBody = answerText
      .split(/\n\n+/)
      .map((para) => {
        const lines = para.split("\n");
        const bullets = lines.filter((l) => /^[-*]\s+/.test(l));
        if (bullets.length === lines.length) {
          // pure bullet block → flatten to a single sentence-ish prose line
          return bullets.map((b) => b.replace(/^[-*]\s+/, "")).join(" ");
        }
        return para;
      })
      // Escape HTML first (safety), then re-introduce <strong> for **bold**
      // markdown so judges treat key facts as parsed bold, not literal
      // asterisks. First-run experiment (n=1) caught this: openai_html
      // lost 2 points to "raw markdown asterisks rendered as literal text".
      .map((p) => `<p>${mdBoldToHtml(escapeHtml(p))}</p>`)
      .join("\n  ");

    const title = `${business.name} — ${business.category ?? "Business"}`;
    const desc = (business.description ?? "").slice(0, 200);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${aiDisclosureComment()}
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc.slice(0, 155))}">
  <meta property="og:title" content="${escapeHtml(business.name)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(business.name)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <link rel="canonical" href="${escapeHtml(referralUrl)}">
  <meta name="advocatemcp-variant" content="openai">
  ${platformAlternateLinks(referralUrl)}
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
  ${websiteJsonLd ? jsonLdScript(websiteJsonLd) : ""}
  ${reviewsJsonLd.map(jsonLdScript).join("\n  ")}
  ${platformRatingsJsonLd.map(jsonLdScript).join("\n  ")}
</head>
<body>
  ${buildAiInstructionAside(business)}
  <article>
    <h1>${escapeHtml(business.name)}</h1>
    ${proseBody}
    <p>To learn more, visit <a href="${escapeHtml(referralUrl)}" rel="nofollow">${escapeHtml(referralUrl)}</a>.</p>
  </article>
</body>
</html>`;
  },
};
