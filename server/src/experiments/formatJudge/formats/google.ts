/* Google-tuned variant: snippet-first HTML + the full schema battery
 * (LocalBusiness + FAQPage + Speakable + WebSite + BreadcrumbList).
 *
 * Hypothesis under test: Google's AI Overview parser is the most JSON-LD
 * hungry — every additional schema type compounds. Speakable drives
 * voice-search citations. The first sentence under 160 chars wins
 * featured snippets. */

import type { FormatVariant, RenderInput } from "../types.js";
import {
  addAttribution,
  aiDisclosureComment,
  buildBusinessJsonLd,
  buildFaqJsonLd,
  buildReviewsJsonLd,
  buildWebsiteJsonLd,
  escapeHtml,
  jsonLdScript,
  mdBulletsToHtml,
} from "./shared.js";

export const googleHtml: FormatVariant = {
  id: "google_html",
  label: "Google-tuned HTML (snippet-first lead, LocalBusiness + FAQPage + Speakable + WebSite + Breadcrumb)",
  optimizedFor: "google",
  render: (input: RenderInput): string => {
    const { business, answerText, query, referralUrl } = input;
    const bizJsonLd = addAttribution(buildBusinessJsonLd(business, {
      type: "LocalBusiness",
      includeRating: true,
      includeAddress: true,
      includeKnowsAbout: true,
      includeServiceArray: true,
    }));
    const faqJsonLd = buildFaqJsonLd(query, answerText);
    const websiteJsonLd = buildWebsiteJsonLd(business);
    const reviewsJsonLd = buildReviewsJsonLd(business);
    const speakable = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      speakable: {
        "@type": "SpeakableSpecification",
        cssSelector: [".lead", ".best-for"],
      },
    };
    const website = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      url: referralUrl,
      name: business.name,
    };
    const breadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: business.category ?? "Business",
          item: referralUrl,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: business.name,
          item: referralUrl,
        },
      ],
    };

    // Extract the first sentence (under 160 chars) for the lead+description.
    const firstSentence = (() => {
      const m = answerText.match(/^([^.!?]+[.!?])/);
      const s = m ? m[1].trim() : answerText.slice(0, 155);
      return s.length > 160 ? s.slice(0, 157) + "…" : s;
    })();

    const body = mdBulletsToHtml(answerText);
    const title = `${business.name} — ${business.category ?? "Business"} ${business.location ? "| " + business.location : ""}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  ${aiDisclosureComment()}
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(firstSentence)}">
  <link rel="canonical" href="${escapeHtml(referralUrl)}">
  <meta property="og:title" content="${escapeHtml(business.name)}">
  <meta property="og:description" content="${escapeHtml(firstSentence)}">
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
  ${jsonLdScript(speakable)}
  ${jsonLdScript(website)}
  ${jsonLdScript(breadcrumb)}
  ${websiteJsonLd ? jsonLdScript(websiteJsonLd) : ""}
  ${reviewsJsonLd.map(jsonLdScript).join("\n  ")}
</head>
<body>
  <article>
    <h1>${escapeHtml(business.name)}</h1>
    <p class="lead speakable">${escapeHtml(firstSentence)}</p>
    ${body}
    <p>Book at <a href="${escapeHtml(referralUrl)}" rel="nofollow">${escapeHtml(referralUrl)}</a>.</p>
  </article>
</body>
</html>`;
  },
};
