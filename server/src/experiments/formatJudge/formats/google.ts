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
  buildPageTitle,
  buildBusinessJsonLd,
  buildFaqJsonLd,
  buildReviewsJsonLd,
  buildPlatformRatingsJsonLd,
  buildWebsiteJsonLd,
  escapeHtml,
  jsonLdScript,
  mdBulletsToHtml,
  mergeFaqsForRenderer,
  platformAlternateLinks,
} from "./shared.js";

export const googleHtml: FormatVariant = {
  id: "google_html",
  label: "Google-tuned HTML (snippet-first lead, LocalBusiness + FAQPage + Speakable + WebSite + Breadcrumb)",
  optimizedFor: "google",
  render: (input: RenderInput): string => {
    const { business, answerText, query, referralUrl, mentionsGraph } = input;
    const bizJsonLd = addAttribution(buildBusinessJsonLd(business, {
      type: "LocalBusiness",
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
    // Don't truncate with ellipsis — judges flagged "lead paragraph
    // truncated with an ellipsis in the rendered body" as a quality
    // deduction. If the first sentence is over 160 chars, fall back to
    // building a synthetic lead from name + category + location that
    // we know fits cleanly.
    const firstSentence = (() => {
      const m = answerText.match(/^([^.!?]+[.!?])/);
      const candidate = m ? m[1].trim() : "";
      if (candidate && candidate.length <= 160) return candidate;
      // Synthesise a lead under 160 chars from structured fields.
      const parts: string[] = [business.name];
      if (business.category) parts.push(`is a ${business.category}`);
      if (business.location) parts.push(`in ${business.location}`);
      if (business.differentiator && parts.join(" ").length + business.differentiator.length + 3 <= 158) {
        parts.push(`— ${business.differentiator.split(/[.;]/)[0]?.trim() ?? ""}`);
      }
      const synthetic = parts.filter(Boolean).join(" ").trim() + ".";
      return synthetic.length <= 160 ? synthetic : `${business.name} is a ${business.category ?? "business"} in ${business.location ?? "the US"}.`;
    })();

    const body = mdBulletsToHtml(answerText);
    const title = buildPageTitle(business);

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
  <meta name="advocatemcp-variant" content="google">
  ${platformAlternateLinks(referralUrl)}
  ${jsonLdScript(bizJsonLd)}
  ${jsonLdScript(faqJsonLd)}
  ${jsonLdScript(speakable)}
  ${jsonLdScript(website)}
  ${jsonLdScript(breadcrumb)}
  ${websiteJsonLd ? jsonLdScript(websiteJsonLd) : ""}
  ${reviewsJsonLd.map(jsonLdScript).join("\n  ")}
  ${platformRatingsJsonLd.map(jsonLdScript).join("\n  ")}
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
